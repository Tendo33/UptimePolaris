package polaris

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
)

type aiRoundTrip func(*http.Request) (*http.Response, error)

func (f aiRoundTrip) RoundTrip(req *http.Request) (*http.Response, error) { return f(req) }

func TestAIProbeResponseContract(t *testing.T) {
	data, err := os.ReadFile("../../../../test/fixtures/ai-probe-responses.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Name     string `json:"name"`
		Protocol string `json:"protocol"`
		Status   int    `json:"status"`
		Body     Object `json:"body"`
		Outcome  string `json:"outcome"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Name, func(t *testing.T) {
			if got := classifyAIResponse(tc.Status, tc.Body, tc.Protocol); got != tc.Outcome {
				t.Fatalf("got %q, want %q", got, tc.Outcome)
			}
		})
	}
}

func TestAIProbeProtocols(t *testing.T) {
	data, err := os.ReadFile("../../../../test/fixtures/ai-protocols.json")
	if err != nil {
		t.Fatal(err)
	}
	var cases []struct {
		Protocol string            `json:"protocol"`
		Path     string            `json:"path"`
		Headers  map[string]string `json:"headers"`
		Body     Object            `json:"body"`
		Response Object            `json:"response"`
		Models   Object            `json:"models"`
	}
	if err := json.Unmarshal(data, &cases); err != nil {
		t.Fatal(err)
	}
	for _, tc := range cases {
		t.Run(tc.Protocol, func(t *testing.T) {
			calls := 0
			client := &http.Client{Transport: aiRoundTrip(func(req *http.Request) (*http.Response, error) {
				calls++
				path, response := tc.Path, tc.Response
				if req.Method == "GET" {
					path, response = "models", tc.Models
				} else {
					var body Object
					if err := json.NewDecoder(req.Body).Decode(&body); err != nil || !reflect.DeepEqual(body, tc.Body) {
						t.Fatal("request body", body, err)
					}
				}
				if req.URL.String() != "https://provider.example/custom%2Ftenant/v1//"+path {
					t.Fatal(req.URL)
				}
				for _, key := range []string{"authorization", "x-api-key", "x-goog-api-key", "anthropic-version"} {
					if req.Header.Get(key) != tc.Headers[key] {
						t.Fatal("auth header", key)
					}
				}
				encoded, _ := json.Marshal(response)
				return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(string(encoded)))}, nil
			})}
			config := aiProbeConfig{Protocol: tc.Protocol, BaseURL: "https://provider.example/custom%2Ftenant/v1//", APIKey: "fixture-secret", Model: "fixture-model", TimeoutMS: 1000}
			if got := probeAIModel(context.Background(), config, client); got.Outcome != "ok" {
				t.Fatal(got)
			}
			if got := probeAIChannel(context.Background(), config, client); got.Outcome != "ok" {
				t.Fatal(got)
			}
			if calls != 2 {
				t.Fatal(calls)
			}
		})
	}
	client := &http.Client{Transport: aiRoundTrip(func(*http.Request) (*http.Response, error) {
		t.Fatal("invalid Gemini model requested")
		return nil, nil
	})}
	for _, model := range []string{"models/gemini-model", "../models", "%2e%2e", "gemini?key=secret", "gemini#fragment"} {
		if got := probeAIModel(context.Background(), aiProbeConfig{Protocol: "gemini", BaseURL: "https://provider.example/v1beta", APIKey: "fixture-secret", Model: model, TimeoutMS: 1000}, client); got.Outcome != "invalid_config" {
			t.Fatal(got)
		}
	}
}

func TestAIProbeIsolatedUpstream(t *testing.T) {
	var calls atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer fixture-secret" {
			t.Error("missing fixture credential")
		}
		switch r.URL.EscapedPath() {
		case "/custom%2Ftenant/v1//chat/completions":
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"OK"}}]}`)
		case "/redirect/chat/completions":
			w.Header().Set("Location", "https://attacker.example/received")
			w.WriteHeader(302)
		case "/unsupported/models":
			w.WriteHeader(405)
			_, _ = io.WriteString(w, `{"error":{"message":"fixture-secret"}}`)
		default:
			t.Errorf("unexpected upstream request: %s", r.URL)
		}
	}))
	defer server.Close()
	transport := server.Client().Transport.(*http.Transport).Clone()
	transport.TLSClientConfig = transport.TLSClientConfig.Clone()
	transport.TLSClientConfig.ServerName = "127.0.0.1"
	transport.DialContext = func(ctx context.Context, network, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, network, server.Listener.Addr().String())
	}
	client := &http.Client{Transport: transport}
	defer transport.CloseIdleConnections()
	config := aiProbeConfig{Protocol: "openai", BaseURL: "https://provider.example/custom%2Ftenant/v1//", APIKey: "fixture-secret", Model: "fixture-model", TimeoutMS: 1000}
	if result := probeAIModel(context.Background(), config, client); result.Outcome != "ok" {
		t.Fatal(result)
	}
	config.BaseURL = "https://provider.example/redirect"
	if result := probeAIModel(context.Background(), config, client); result.Outcome != "unexpected_status" {
		t.Fatal(result)
	}
	if calls.Load() != 2 {
		t.Fatal("credentials forwarded by redirect", calls.Load())
	}
	config.BaseURL = "https://provider.example/unsupported"
	if result := probeAIChannel(context.Background(), config, client); result.Outcome != "models_endpoint_unsupported" {
		t.Fatal(result)
	}
	secure := aiHTTPClient().Transport.(*http.Transport)
	if secure.Proxy != nil {
		t.Fatal("AI transport trusts environment proxy")
	}
	for _, address := range []string{"100.100.100.200:443", "169.254.169.254:443", "[fd00:ec2::254]:443"} {
		if connection, err := secure.DialContext(context.Background(), "tcp", address); err == nil {
			connection.Close()
			t.Fatal("metadata dial permitted", address)
		}
	}
}

func TestAIProbeRequest(t *testing.T) {
	config := aiProbeConfig{Protocol: "openai", BaseURL: "https://provider.example/v1/", APIKey: "fixture-secret", Model: "fixture-model", TimeoutMS: 1000}
	client := &http.Client{Transport: aiRoundTrip(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != "https://provider.example/v1/chat/completions" || req.Method != "POST" || req.Header.Get("Authorization") != "Bearer fixture-secret" {
			t.Fatal("invalid request", req.URL, req.Method)
		}
		var body Object
		if err := json.NewDecoder(req.Body).Decode(&body); err != nil || str(body, "model") != "fixture-model" || number(body["max_tokens"]) != 64 || boolean(body["stream"]) {
			t.Fatal("invalid request body", body, err)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"OK"}}]}`))}, nil
	})}
	if got := probeAIModel(context.Background(), config, client); got.Outcome != "ok" || got.StatusCode != 200 {
		t.Fatal(got)
	}
	config.BaseURL = "https://user:pass@provider.example"
	if got := probeAIModel(context.Background(), config, client); got.Outcome != "invalid_config" {
		t.Fatal(got)
	}
	config.BaseURL = "https://provider.example"
	client.Transport = aiRoundTrip(func(req *http.Request) (*http.Response, error) {
		if req.URL.String() != "https://provider.example/v1%2Ftenant/chat/completions" {
			t.Fatal(req.URL)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(strings.Repeat("x", 65536)))}, nil
	})
	config.BaseURL = "https://provider.example/v1%2Ftenant"
	if got := probeAIModel(context.Background(), config, client); got.Outcome != "invalid_response" {
		t.Fatal(got)
	}
	config.BaseURL = "https://provider.example"
	client.Transport = aiRoundTrip(func(*http.Request) (*http.Response, error) { return nil, errors.New("fixture-secret") })
	got := probeAIModel(context.Background(), config, client)
	if got.Outcome != "network_error" || strings.Contains(got.Outcome, config.APIKey) {
		t.Fatal(got)
	}
	client.Transport = aiRoundTrip(func(*http.Request) (*http.Response, error) { return nil, context.DeadlineExceeded })
	if got := probeAIModel(context.Background(), config, client); got.Outcome != "timeout" {
		t.Fatal(got)
	}
	calls := 0
	client.Transport = aiRoundTrip(func(*http.Request) (*http.Response, error) {
		calls++
		return &http.Response{StatusCode: 302, Header: http.Header{"Location": []string{"https://other.example"}}, Body: io.NopCloser(strings.NewReader(""))}, nil
	})
	if got := probeAIModel(context.Background(), config, client); got.Outcome != "unexpected_status" || calls != 1 {
		t.Fatal(got, calls)
	}
}
