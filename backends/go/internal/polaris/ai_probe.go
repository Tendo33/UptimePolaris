package polaris

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type aiProbeConfig struct {
	Headers   Object
	Request   Object
	Protocol  string
	BaseURL   string
	APIKey    string
	Model     string
	TimeoutMS int64
}

func aiAuthHeaders(req *http.Request, config aiProbeConfig) {
	for name, value := range config.Headers {
		req.Header.Set(name, value.(string))
	}
	switch config.Protocol {
	case "anthropic":
		req.Header.Set("X-Api-Key", config.APIKey)
		req.Header.Set("Anthropic-Version", "2026-10-21")
	case "gemini":
		req.Header.Set("X-Goog-Api-Key", config.APIKey)
	default:
		req.Header.Set("Authorization", "Bearer "+config.APIKey)
	}
}

func aiModelRequest(config aiProbeConfig) (string, Object) {
	options := config.Request
	if options == nil {
		options = defaultAIRequest()
	}
	prompt, maxTokens := str(options, "prompt"), integer(options, "maxOutputTokens")
	messages := []Object{{"role": "user", "content": prompt}}
	body := func(defaults, controlled Object) Object {
		return mergeAIBody(mergeAIBody(defaults, object(options["body"])), controlled)
	}
	switch config.Protocol {
	case "openai_responses":
		return "responses", body(Object{"input": prompt}, Object{"model": config.Model, "max_output_tokens": maxTokens, "stream": false, "store": false})
	case "anthropic":
		return "messages", body(Object{"messages": messages}, Object{"model": config.Model, "max_tokens": maxTokens, "stream": false})
	case "gemini":
		return "models/" + url.PathEscape(config.Model) + ":generateContent", body(Object{"contents": []Object{{"role": "user", "parts": []Object{{"text": prompt}}}}}, Object{"generationConfig": Object{"maxOutputTokens": maxTokens}})
	default:
		payload := body(Object{"messages": messages}, Object{"model": config.Model, "max_tokens": maxTokens, "stream": false})
		if _, present := object(options["body"])["max_completion_tokens"]; present {
			delete(payload, "max_tokens")
			payload["max_completion_tokens"] = maxTokens
		}
		return "chat/completions", payload
	}
}

type aiProbeResult struct {
	Outcome       string  `json:"outcome"`
	StatusCode    int     `json:"statusCode"`
	LatencyMS     float64 `json:"latencyMs"`
	RetryAfterSec int64   `json:"retryAfterSec,omitempty"`
}

func probeAIModel(ctx context.Context, config aiProbeConfig, client *http.Client) aiProbeResult {
	start := time.Now()
	var retryAfter int64
	result := func(outcome string, status int) aiProbeResult {
		return aiProbeResult{Outcome: outcome, StatusCode: status, LatencyMS: elapsed(start), RetryAfterSec: retryAfter}
	}
	if config.Headers == nil {
		config.Headers = Object{}
	}
	if _, err := aiHeaders(config.Headers); err != nil {
		return result("invalid_config", 0)
	}
	target, err := aiBaseURL(config.BaseURL)
	if err != nil || target.Host == "" || (target.Scheme != "http" && target.Scheme != "https") || target.User != nil || target.RawQuery != "" || target.Fragment != "" ||
		!validAIProtocol(config.Protocol) || strings.TrimSpace(config.APIKey) == "" || !validAIModelID(config.Protocol, config.Model) || config.TimeoutMS <= 0 {
		return result("invalid_config", 0)
	}
	if config.Request == nil {
		config.Request = defaultAIRequest()
	}
	if _, err := aiRequest(config.Request); err != nil {
		return result("invalid_config", 0)
	}
	path, payload := aiModelRequest(config)
	target.RawPath = strings.TrimSuffix(target.EscapedPath(), "/") + "/" + path
	target.Path, err = url.PathUnescape(target.RawPath)
	if err != nil {
		return result("invalid_config", 0)
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(config.TimeoutMS)*time.Millisecond)
	defer cancel()
	body, err := json.Marshal(payload)
	if err != nil {
		return result("invalid_config", 0)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, target.String(), bytes.NewReader(body))
	if err != nil {
		return result("invalid_config", 0)
	}
	req.Header.Set("Content-Type", "application/json")
	aiAuthHeaders(req, config)
	if client == nil {
		client = aiHTTPClient()
	}
	safeClient := *client
	safeClient.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	response, err := safeClient.Do(req)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return result("timeout", 0)
		}
		return result("network_error", 0)
	}
	defer response.Body.Close()
	if response.StatusCode == 429 {
		value := response.Header.Get("Retry-After")
		if n, e := strconv.ParseInt(value, 10, 64); e == nil && n > 0 {
			retryAfter = n
		} else if date, e := http.ParseTime(value); e == nil {
			retryAfter = int64(time.Until(date).Seconds()) + 1
			if retryAfter < 0 {
				retryAfter = 0
			}
		}
	}
	if response.StatusCode == 401 || response.StatusCode == 403 || response.StatusCode == 404 || response.StatusCode >= 500 {
		return result(classifyAIResponse(response.StatusCode, nil, config.Protocol), response.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, 65537))
	if response.StatusCode == 429 && (err != nil || len(data) >= 65536) {
		return result("rate_limit_or_quota", response.StatusCode)
	}
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return result("timeout", response.StatusCode)
		}
		return result("network_error", response.StatusCode)
	}
	if len(data) >= 65536 {
		return result("invalid_response", response.StatusCode)
	}
	var decoded Object
	_ = json.Unmarshal(data, &decoded)
	outcome := classifyAIResponse(response.StatusCode, decoded, config.Protocol)
	if outcome == "ok" && str(config.Request, "expectedText") != "" && !strings.Contains(aiResponseText(decoded, config.Protocol), str(config.Request, "expectedText")) {
		outcome = "response_mismatch"
	}
	return result(outcome, response.StatusCode)
}

func probeAIChannel(ctx context.Context, config aiProbeConfig, client *http.Client) aiProbeResult {
	_, result := fetchAIModels(ctx, config, client, false)
	return result
}

func classifyAIResponse(status int, body Object, protocol string) string {
	switch status {
	case 401:
		return "authentication_failed"
	case 403:
		return "permission_denied"
	case 404:
		return "model_or_endpoint_unavailable"
	case 429:
		err := object(body["error"])
		codes := []string{str(err, "code"), str(err, "type")}
		for _, code := range codes {
			if contains([]string{"insufficient_quota", "credit_balance_exhausted", "organization_spend_limit_exceeded", "project_spend_limit_exceeded", "organization_usage_limit_exceeded", "usage_limit_exceeded"}, code) {
				return "quota_exhausted"
			}
		}
		for _, code := range codes {
			if contains([]string{"rate_limit_exceeded", "rate_limit_error", "slow_down"}, code) {
				return "rate_limited"
			}
		}
		return "rate_limit_or_quota"
	}
	if status >= 500 && status <= 599 {
		return "upstream_unavailable"
	}
	if status >= 400 && status <= 499 {
		return "request_invalid"
	}
	if status < 200 || status > 299 {
		return "unexpected_status"
	}
	if body["error"] != nil {
		return "invalid_response"
	}
	valid := false
	switch protocol {
	case "openai_responses":
		if body["status"] != "completed" && body["status"] != "incomplete" {
			return "invalid_response"
		}
		for _, item := range array(body["output"]) {
			message := object(item)
			if message["type"] == "message" && message["role"] == "assistant" && aiHasText(message["content"], "output_text") {
				valid = true
			}
		}
	case "anthropic":
		valid = body["type"] == "message" && body["role"] == "assistant" && aiHasText(body["content"], "text")
	case "gemini":
		for _, item := range array(body["candidates"]) {
			content := object(object(item)["content"])
			for _, part := range array(content["parts"]) {
				block := object(part)
				if block["thought"] != true && strings.TrimSpace(str(block, "text")) != "" {
					valid = true
				}
			}
		}
	default:
		choices := array(body["choices"])
		if len(choices) > 0 {
			message := object(object(choices[0])["message"])
			valid = strings.TrimSpace(str(message, "content")) != ""
		}
	}
	if !valid {
		return "invalid_response"
	}
	return "ok"
}

func aiHasText(value any, kind string) bool {
	for _, block := range array(value) {
		content := object(block)
		if content["type"] == kind && strings.TrimSpace(str(content, "text")) != "" {
			return true
		}
	}
	return false
}
