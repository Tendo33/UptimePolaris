package polaris

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"
)

const aiModelsMaxBytes = 2 * 1024 * 1024
const aiModelsMaxPages = 10
const aiModelsMaxCount = 10000

func parseAIModelPage(protocol string, body Object) ([]Object, string, bool) {
	key := "data"
	if protocol == "gemini" {
		key = "models"
	}
	rows, ok := body[key].([]any)
	if !ok || body["error"] != nil {
		return nil, "", false
	}
	models := []Object{}
	for _, raw := range rows {
		row := object(raw)
		id, name := str(row, "id"), str(row, "display_name")
		if protocol == "gemini" {
			if _, present := row["supportedGenerationMethods"].([]any); present && !contains(stringsOf(row["supportedGenerationMethods"]), "generateContent") {
				continue
			}
			id, name = strings.TrimPrefix(str(row, "name"), "models/"), str(row, "displayName")
		}
		id = strings.TrimSpace(id)
		if !validAIModelID(protocol, id) || utf8.RuneCountInString(id) > 200 || strings.ContainsAny(id, "\x00\x7f") || strings.IndexFunc(id, func(ch rune) bool { return ch < 32 }) >= 0 {
			continue
		}
		name = strings.TrimSpace(strings.Map(func(ch rune) rune {
			if ch < 32 || ch == 127 {
				return -1
			}
			return ch
		}, name))
		if runes := []rune(name); len(runes) > 120 {
			name = string(runes[:120])
		}
		var display any
		if name != "" {
			display = name
		}
		models = append(models, Object{"id": id, "name": display})
	}
	var next any
	if protocol == "gemini" {
		next = body["nextPageToken"]
	} else if body["has_more"] == true {
		next = body["last_id"]
	}
	cursor := ""
	if next != nil {
		var ok bool
		cursor, ok = next.(string)
		if !ok || len(cursor) > 2048 || strings.IndexFunc(cursor, func(ch rune) bool { return ch < 32 || ch == 127 }) >= 0 {
			return nil, "", false
		}
	}
	if protocol != "gemini" && body["has_more"] == true && cursor == "" {
		return nil, "", false
	}
	return models, cursor, true
}

func fetchAIModels(ctx context.Context, config aiProbeConfig, client *http.Client, allPages bool) ([]Object, aiProbeResult) {
	start := time.Now()
	result := func(outcome string, status int) aiProbeResult {
		return aiProbeResult{Outcome: outcome, StatusCode: status, LatencyMS: elapsed(start)}
	}
	if config.Headers == nil {
		config.Headers = Object{}
	}
	if _, err := aiHeaders(config.Headers); err != nil {
		return nil, result("invalid_config", 0)
	}
	target, err := aiBaseURL(config.BaseURL)
	if err != nil || !validAIProtocol(config.Protocol) || config.APIKey == "" || config.TimeoutMS <= 0 {
		return nil, result("invalid_config", 0)
	}
	target.RawPath = strings.TrimSuffix(target.EscapedPath(), "/") + "/models"
	target.Path, err = url.PathUnescape(target.RawPath)
	if err != nil {
		return nil, result("invalid_config", 0)
	}
	ctx, cancel := context.WithTimeout(ctx, time.Duration(config.TimeoutMS)*time.Millisecond)
	defer cancel()
	if client == nil {
		client = aiHTTPClient()
	}
	safe := *client
	safe.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	models := []Object{}
	seen, seenCursors := map[string]bool{}, map[string]bool{}
	consumed := 0
	for page := 0; page < aiModelsMaxPages; page++ {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return nil, result("invalid_config", 0)
		}
		aiAuthHeaders(req, config)
		response, err := safe.Do(req)
		if err != nil {
			outcome := "network_error"
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
				outcome = "timeout"
			}
			return nil, result(outcome, 0)
		}
		status := response.StatusCode
		if status == 404 || status == 405 || status == 501 {
			response.Body.Close()
			return nil, result("models_endpoint_unsupported", status)
		}
		if status == 401 || status == 403 || status >= 500 || status >= 300 && status < 400 {
			response.Body.Close()
			return nil, result(classifyAIResponse(status, nil, config.Protocol), status)
		}
		data, err := io.ReadAll(io.LimitReader(response.Body, int64(aiModelsMaxBytes-consumed+1)))
		response.Body.Close()
		if err != nil {
			outcome := "network_error"
			if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
				outcome = "timeout"
			}
			return nil, result(outcome, status)
		}
		consumed += len(data)
		if consumed > aiModelsMaxBytes {
			outcome := "invalid_response"
			if status == 429 {
				outcome = "rate_limit_or_quota"
			}
			return nil, result(outcome, status)
		}
		var body Object
		_ = json.Unmarshal(data, &body)
		if status < 200 || status > 299 {
			return nil, result(classifyAIResponse(status, body, config.Protocol), status)
		}
		rows, cursor, valid := parseAIModelPage(config.Protocol, body)
		if !valid {
			return nil, result("invalid_response", status)
		}
		for _, row := range rows {
			id := str(row, "id")
			if !seen[id] {
				seen[id] = true
				models = append(models, row)
			}
		}
		if len(models) > aiModelsMaxCount {
			return nil, result("invalid_response", status)
		}
		if !allPages || cursor == "" {
			return models, result("ok", status)
		}
		if seenCursors[cursor] || consumed >= aiModelsMaxBytes {
			return nil, result("invalid_response", status)
		}
		seenCursors[cursor] = true
		key := "after_id"
		if config.Protocol == "gemini" {
			key = "pageToken"
		}
		query := target.Query()
		query.Set(key, cursor)
		target.RawQuery = query.Encode()
	}
	return nil, result("invalid_response", 200)
}

func (a *App) aiRemoteModels(w http.ResponseWriter, r *http.Request) error {
	channel, err := a.store.get(r.Context(), "ai_channel", r.PathValue("id"))
	if err != nil {
		return err
	}
	if channel == nil {
		return failure("not_found", 404)
	}
	key, err := a.decryptAICredential(r.Context(), channel)
	if err != nil {
		return err
	}
	headers, err := a.decryptAIHeaders(r.Context(), channel)
	if err != nil {
		return err
	}
	models, result := fetchAIModels(r.Context(), aiProbeConfig{Protocol: str(channel, "protocol"), BaseURL: str(channel, "baseUrl"), APIKey: key, Headers: headers, TimeoutMS: 15000}, a.aiClient, true)
	current, err := a.store.get(r.Context(), "ai_channel", str(channel, "id"))
	if err != nil {
		return err
	}
	if current == nil {
		return failure("not_found", 404)
	}
	if current["revision"] != channel["revision"] {
		return failure("revision_conflict", 409)
	}
	if result.Outcome != "ok" {
		respond(w, 502, Object{"error": "ai_models_unavailable", "outcome": result.Outcome})
		return nil
	}
	respond(w, 200, Object{"models": models, "fetchedAt": time.Now().Unix()})
	return nil
}
