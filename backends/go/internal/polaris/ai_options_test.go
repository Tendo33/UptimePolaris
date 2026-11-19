package polaris

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func TestAIProbeOptions(t *testing.T) {
	data, err := os.ReadFile("../../../../test/fixtures/ai-options.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Request         Object   `json:"request"`
		Headers         Object   `json:"headers"`
		InvalidHeaders  []Object `json:"invalidHeaders"`
		InvalidRequests []Object `json:"invalidRequests"`
	}
	if err = json.Unmarshal(data, &fixture); err != nil {
		t.Fatal(err)
	}
	for _, headers := range fixture.InvalidHeaders {
		if _, err := aiHeaders(headers); err == nil {
			t.Fatal("invalid headers accepted", headers)
		}
	}
	for _, request := range fixture.InvalidRequests {
		if _, err := aiRequest(request); err == nil {
			t.Fatal("invalid request accepted", request)
		}
	}
	for _, protocol := range []string{"openai", "openai_responses", "anthropic", "gemini"} {
		t.Run(protocol, func(t *testing.T) {
			config := aiProbeConfig{Protocol: protocol, BaseURL: "https://provider.example/v1", APIKey: "fixture-secret", Model: "fixture-model", TimeoutMS: 1000, Headers: fixture.Headers, Request: fixture.Request}
			client := &http.Client{Transport: aiRoundTrip(func(r *http.Request) (*http.Response, error) {
				if r.Header.Get("CF-Access-Client-Secret") != "private-header-fixture" {
					t.Fatal("missing header")
				}
				var body Object
				if json.NewDecoder(r.Body).Decode(&body) != nil {
					t.Fatal("invalid JSON")
				}
				switch protocol {
				case "gemini":
					if str(object(array(object(array(body["contents"])[0])["parts"])[0]), "text") != str(fixture.Request, "prompt") || integer(object(body["generationConfig"]), "maxOutputTokens") != 128 {
						t.Fatal(body)
					}
				case "openai_responses":
					if body["input"] != fixture.Request["prompt"] || integer(body, "max_output_tokens") != 128 {
						t.Fatal(body)
					}
				default:
					if str(object(array(body["messages"])[0]), "content") != str(fixture.Request, "prompt") || integer(body, "max_tokens") != 128 {
						t.Fatal(body)
					}
				}
				response := Object{"choices": []Object{{"message": Object{"content": "OK"}}}}
				if protocol == "openai_responses" {
					response = Object{"status": "completed", "output": []Object{{"type": "message", "role": "assistant", "content": []Object{{"type": "output_text", "text": "OK"}}}}}
				}
				if protocol == "anthropic" {
					response = Object{"type": "message", "role": "assistant", "content": []Object{{"type": "text", "text": "OK"}}}
				}
				if protocol == "gemini" {
					response = Object{"candidates": []Object{{"content": Object{"parts": []Object{{"text": "OK"}}}}}}
				}
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(encode(response)))}, nil
			})}
			if got := probeAIModel(context.Background(), config, client); got.Outcome != "response_mismatch" {
				t.Fatal(got)
			}
			config.Request = clone(fixture.Request)
			config.Request["expectedText"] = "OK"
			if got := probeAIModel(context.Background(), config, client); got.Outcome != "ok" {
				t.Fatal(got)
			}
		})
	}
}

func runAIOptions(t *testing.T, s *testServer) {
	t.Helper()
	ctx := context.Background()
	req := func(method, path string, input any, want int) Object {
		status, result := s.request(t, method, path, input, true)
		expectStatus(t, status, want, result)
		if strings.Contains(encode(result), "private-header-fixture") {
			t.Fatal("header value leaked")
		}
		return result
	}
	channel := object(req("POST", "/api/admin/ai/channels", Object{"name": "Options fixture", "protocol": "openai", "baseUrl": "https://provider.example/v1", "apiKey": "fixture-secret", "headers": Object{"CF-Access-Client-Secret": "private-header-fixture"}}, 201)["channel"])
	path := "/api/admin/ai/channels/" + str(channel, "id")
	stored, err := s.app.store.get(ctx, "ai_channel", str(channel, "id"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(str(stored, "headers_ciphertext"), "private-header-fixture") {
		t.Fatal("plaintext header persisted")
	}
	decoded, err := s.app.decryptAIHeaders(ctx, stored)
	if err != nil || decoded["cf-access-client-secret"] != "private-header-fixture" {
		t.Fatal("header encryption", err)
	}
	channel = object(req("PUT", path, channel, 200)["channel"])
	retained, _ := s.app.store.get(ctx, "ai_channel", str(channel, "id"))
	if retained["headers_ciphertext"] != stored["headers_ciphertext"] {
		t.Fatal("omitted headers changed")
	}
	model := object(req("POST", "/api/admin/ai/models", Object{"name": "Options model", "channelId": channel["id"], "modelId": "fixture", "isPublic": true, "request": Object{"prompt": "Return READY.", "maxOutputTokens": 128, "expectedText": "READY"}}, 201)["model"])
	modelPath := "/api/admin/ai/models/" + str(model, "id")
	calls := 0
	s.app.aiClient = &http.Client{Transport: aiRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls++
		if r.Header.Get("CF-Access-Client-Secret") != "private-header-fixture" {
			t.Fatal("custom auth missing")
		}
		var b Object
		_ = json.NewDecoder(r.Body).Decode(&b)
		if integer(b, "max_tokens") != 128 || str(object(array(b["messages"])[0]), "content") != "Return READY." {
			t.Fatal(b)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"READY"}}]}`))}, nil
	})}
	check := func() Object {
		return object(req("POST", modelPath+"/check", Object{"revision": model["revision"], "channelRevision": channel["revision"], "confirmPaid": true}, 200)["result"])
	}
	if check()["outcome"] != "ok" {
		t.Fatal("custom check failed")
	}
	change := clone(model)
	request := clone(object(model["request"]))
	request["expectedText"] = "DIFFERENT"
	change["request"] = request
	model = object(req("PUT", modelPath, change, 200)["model"])
	change = clone(model)
	delete(change, "request")
	model = object(req("PUT", modelPath, change, 200)["model"])
	if object(model["request"])["expectedText"] != "DIFFERENT" || check()["outcome"] != "response_mismatch" {
		t.Fatal("request options lost")
	}
	s.app.aiCycle(ctx, true)
	view := object(req("GET", modelPath, nil, 200)["model"])
	if object(view["live"])["outcome"] != "response_mismatch" {
		t.Fatal(view)
	}
	state, err := s.app.presentation(ctx)
	if err != nil {
		t.Fatal(err)
	}
	config := clone(object(state["config"]))
	config["aiOnMonitorPage"] = false
	state = req("PUT", "/api/admin/presentation", Object{"config": config, "revision": state["revision"]}, 200)
	req("GET", "/api/public/ai/models", nil, 404)
	pub := req("GET", "/api/public/ai/models?view=ai", nil, 200)
	if len(array(pub["models"])) != 1 || strings.Contains(encode(pub), "expectedText") {
		t.Fatal(pub)
	}
	r := httptest.NewRequest("GET", "http://ai.fixture.test/api/public/ai/models", nil)
	config["domains"] = []any{Object{"hostname": "ai.fixture.test", "page": "ai"}}
	state = req("PUT", "/api/admin/presentation", Object{"config": config, "revision": state["revision"]}, 200)
	if err := s.app.aiPublicPage(r); err != nil {
		t.Fatal(err)
	}
	config["aiEnabled"] = false
	state = req("PUT", "/api/admin/presentation", Object{"config": config, "revision": state["revision"]}, 200)
	before := calls
	req("POST", modelPath+"/check", Object{}, 409)
	s.app.aiCycle(ctx, true)
	if calls != before {
		t.Fatal("disabled feature called provider")
	}
	req("GET", "/api/public/ai/models?view=ai", nil, 404)
	change = clone(channel)
	change["headers"] = Object{}
	channel = object(req("PUT", path, change, 200)["channel"])
	if len(stringsOf(channel["headerNames"])) != 0 {
		t.Fatal("headers not cleared")
	}
	req("DELETE", path, Object{"revision": channel["revision"]}, 200)
	config["aiEnabled"] = true
	config["domains"] = []any{}
	req("PUT", "/api/admin/presentation", Object{"config": config, "revision": state["revision"]}, 200)
}
