package polaris

import (
	"context"
	"encoding/json"
	"regexp"
	"strings"
	"unicode/utf8"
)

var aiHeaderName = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$")

func aiHeaders(value any) (Object, error) {
	headers := object(value)
	if headers == nil || len(encode(headers)) > 65536 {
		return nil, failure("invalid_ai_headers", 400)
	}
	result := Object{}
	for name, raw := range headers {
		key := strings.ToLower(name)
		content, ok := raw.(string)
		if !ok || !aiHeaderName.MatchString(key) || strings.HasPrefix(key, "sec-") || contains([]string{"authorization", "x-api-key", "x-goog-api-key", "anthropic-version", "content-type", "host", "content-length", "connection", "transfer-encoding", "upgrade", "cookie", "set-cookie", "proxy-authorization", "proxy-connection", "te", "trailer", "keep-alive"}, key) || len(content) > 2048 {
			return nil, failure("invalid_ai_headers", 400)
		}
		if _, present := result[key]; present {
			return nil, failure("invalid_ai_headers", 400)
		}
		for _, ch := range content {
			if ch < 32 || ch > 126 {
				return nil, failure("invalid_ai_headers", 400)
			}
		}
		result[key] = content
	}
	return result, nil
}

func defaultAIRequest() Object {
	return Object{"prompt": "Reply OK.", "maxOutputTokens": 64, "expectedText": ""}
}
func aiRequest(value any) (Object, error) {
	r := object(value)
	if r == nil || !knownFields(r, []string{"prompt", "maxOutputTokens", "expectedText", "body"}) {
		return nil, failure("invalid_ai_request", 400)
	}
	prompt, promptOK := r["prompt"].(string)
	expected, expectedOK := r["expectedText"].(string)
	tokens := number(r["maxOutputTokens"])
	_, stringTokens := r["maxOutputTokens"].(string)
	if !promptOK || strings.TrimSpace(prompt) == "" || utf8.RuneCountInString(prompt) > 2000 || !expectedOK || utf8.RuneCountInString(expected) > 200 || stringTokens || tokens < 1 || tokens > 4096 || tokens != float64(int(tokens)) {
		return nil, failure("invalid_ai_request", 400)
	}
	for _, ch := range prompt {
		if ch == 127 || ch < 32 && ch != '\n' && ch != '\r' && ch != '\t' {
			return nil, failure("invalid_ai_request", 400)
		}
	}
	for _, ch := range expected {
		if ch < 32 || ch == 127 {
			return nil, failure("invalid_ai_request", 400)
		}
	}
	result := Object{"prompt": prompt, "maxOutputTokens": int(tokens), "expectedText": expected}
	if raw, present := r["body"]; present {
		body := object(raw)
		if body == nil || len(encode(body)) > 65536 || !validAIBodyDepth(body, 0) {
			return nil, failure("invalid_ai_request", 400)
		}
		if len(body) > 0 {
			result["body"] = body
		}
	}
	return result, nil
}

func validAIBodyDepth(value any, depth int) bool {
	if depth > 32 {
		return false
	}
	if fields := object(value); fields != nil {
		for _, child := range fields {
			if !validAIBodyDepth(child, depth+1) {
				return false
			}
		}
	} else if items, ok := value.([]any); ok {
		for _, child := range items {
			if !validAIBodyDepth(child, depth+1) {
				return false
			}
		}
	}
	return true
}

func mergeAIBody(base, overrides Object) Object {
	result := Object{}
	for key, value := range base {
		result[key] = value
	}
	for key, value := range overrides {
		if left, right := object(result[key]), object(value); left != nil && right != nil {
			result[key] = mergeAIBody(left, right)
		} else {
			result[key] = value
		}
	}
	return result
}
func aiModelRequestOptions(model Object) Object {
	if request := object(model["request"]); request != nil {
		return request
	}
	return defaultAIRequest()
}

func (a *App) decryptAIHeaders(ctx context.Context, channel Object) (Object, error) {
	if str(channel, "headers_ciphertext") == "" {
		return Object{}, nil
	}
	input := clone(channel)
	input["id"] = str(channel, "id") + ":headers"
	input["credential_ciphertext"] = channel["headers_ciphertext"]
	plain, err := a.decryptAICredential(ctx, input)
	if err != nil {
		return nil, err
	}
	var headers Object
	if json.Unmarshal([]byte(plain), &headers) != nil {
		return nil, failure("ai_credential_decryption_failed", 503)
	}
	validated, err := aiHeaders(headers)
	if err != nil {
		return nil, failure("ai_credential_decryption_failed", 503)
	}
	return validated, nil
}

func (a *App) aiEnabled(ctx context.Context) (bool, error) {
	state, err := a.presentation(ctx)
	return boolean(object(state["config"])["aiEnabled"]), err
}

func (s *Store) upgradeAIPresentation(ctx context.Context) error {
	return s.mutate(ctx, func(tx *transaction) error {
		state, err := tx.get("config", "presentation")
		if err != nil {
			return err
		}
		if state == nil {
			channels, err := tx.list("ai_channel")
			if err != nil || len(channels) == 0 {
				return err
			}
			config := defaultPresentation()
			config["aiEnabled"] = true
			return tx.put("config", "presentation", Object{"config": config, "revision": uuid()})
		}
		config := object(state["config"])
		if _, present := config["aiEnabled"]; present {
			return nil
		}
		channels, err := tx.list("ai_channel")
		if err != nil {
			return err
		}
		config["aiEnabled"] = len(channels) > 0
		config["aiOnMonitorPage"] = true
		object(config["pages"])["ai"] = Object{"theme": nil, "themeOptions": Object{}}
		state["revision"] = uuid()
		return tx.put("config", "presentation", state)
	})
}

func aiResponseText(body Object, protocol string) string {
	texts := []string{}
	appendBlocks := func(value any, kind string) {
		for _, raw := range array(value) {
			block := object(raw)
			if block["type"] == kind {
				if text, ok := block["text"].(string); ok {
					texts = append(texts, text)
				}
			}
		}
	}
	switch protocol {
	case "openai_responses":
		for _, raw := range array(body["output"]) {
			item := object(raw)
			if item["type"] == "message" && item["role"] == "assistant" {
				appendBlocks(item["content"], "output_text")
			}
		}
	case "anthropic":
		appendBlocks(body["content"], "text")
	case "gemini":
		for _, raw := range array(body["candidates"]) {
			for _, part := range array(object(object(raw)["content"])["parts"]) {
				block := object(part)
				if block["thought"] != true {
					if text, ok := block["text"].(string); ok {
						texts = append(texts, text)
					}
				}
			}
		}
	default:
		choices := array(body["choices"])
		if len(choices) > 0 {
			texts = append(texts, str(object(object(choices[0])["message"]), "content"))
		}
	}
	return strings.Join(texts, "\n")
}
