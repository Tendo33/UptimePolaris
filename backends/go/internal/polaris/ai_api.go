package polaris

import (
	"errors"
	"net/http"
	"reflect"
	"sort"
	"strings"
	"time"
)

func aiView(kind string, row Object) Object {
	fields := []string{"id", "name", "revision", "createdAt", "updatedAt"}
	if kind == "channels" {
		fields = append(fields, "baseUrl", "protocol")
	} else {
		fields = append(fields, "channelId", "modelId", "intervalSec", "timeoutMs", "enabled", "isPublic")
	}
	view := Object{}
	for _, field := range fields {
		view[field] = row[field]
	}
	if kind == "channels" {
		view["hasApiKey"] = str(row, "credential_ciphertext") != ""
		view["headerNames"] = stringsOf(row["headerNames"])
		view["notificationChannelIds"] = stringsOf(row["notificationChannelIds"])
		view["notificationEnabled"] = row["notificationEnabled"] != false
	}
	if kind == "models" {
		view["request"] = aiModelRequestOptions(row)
	}
	return view
}

func aiKind(kind string) string {
	if kind == "channels" {
		return "ai_channel"
	}
	return "ai_model"
}

func (a *App) aiRoute(pattern string, h handler) {
	a.route(pattern, false, func(w http.ResponseWriter, r *http.Request) error {
		r.Body = http.MaxBytesReader(w, r.Body, 262144)
		err := h(w, r)
		if err != nil && (strings.Contains(err.Error(), "SQLITE_BUSY") || strings.Contains(err.Error(), "SQLITE_LOCKED")) {
			return failure("revision_conflict", 409)
		}
		var safe *apiError
		if err != nil && !errors.As(err, &safe) {
			return failure("ai_storage_unavailable", 503)
		}
		return err
	})
}

func (a *App) aiRoutes() {
	for _, kind := range []string{"channels", "models"} {
		a.aiRoute("GET /api/admin/ai/"+kind, func(w http.ResponseWriter, r *http.Request) error {
			rows, err := a.store.list(r.Context(), aiKind(kind))
			if err != nil {
				return err
			}
			views := []Object{}
			if kind == "models" {
				views, err = a.aiModelViews(r.Context(), rows)
				if err != nil {
					return err
				}
				respond(w, 200, Object{kind: views})
				return nil
			}
			for _, row := range rows {
				view := aiView(kind, row)
				views = append(views, view)
			}
			respond(w, 200, Object{kind: views})
			return nil
		})
		a.aiRoute("GET /api/admin/ai/"+kind+"/{id}", func(w http.ResponseWriter, r *http.Request) error {
			row, err := a.store.get(r.Context(), aiKind(kind), r.PathValue("id"))
			if err != nil {
				return err
			}
			if row == nil {
				return failure("not_found", 404)
			}
			key := "model"
			if kind == "channels" {
				key = "channel"
			}
			view := aiView(kind, row)
			if kind == "channels" {
				headers, err := a.decryptAIHeaders(r.Context(), row)
				if err != nil {
					return err
				}
				view["headers"] = headers
			}
			if kind == "models" {
				view, err = a.aiModelView(r.Context(), row)
				if err != nil {
					return err
				}
			}
			respond(w, 200, Object{key: view})
			return nil
		})
		a.aiRoute("POST /api/admin/ai/"+kind, func(w http.ResponseWriter, r *http.Request) error { return a.aiSave(w, r, kind, true) })
		a.aiRoute("PUT /api/admin/ai/"+kind+"/{id}", func(w http.ResponseWriter, r *http.Request) error { return a.aiSave(w, r, kind, false) })
		a.aiRoute("DELETE /api/admin/ai/"+kind+"/{id}", func(w http.ResponseWriter, r *http.Request) error {
			b, err := body(r)
			if err != nil {
				return err
			}
			revision, err := aiText(b["revision"], 64)
			if err != nil {
				return err
			}
			err = a.store.mutate(r.Context(), func(tx *transaction) error {
				row, err := tx.get(aiKind(kind), r.PathValue("id"))
				if err != nil {
					return err
				}
				if row == nil {
					return failure("not_found", 404)
				}
				if row["revision"] != revision {
					return failure("revision_conflict", 409)
				}
				if kind == "channels" {
					models, err := tx.list("ai_model")
					if err != nil {
						return err
					}
					for _, model := range models {
						if model["channelId"] == row["id"] {
							if err = aiRemoveModel(tx, str(model, "id")); err != nil {
								return err
							}
						}
					}
				}
				if kind == "models" {
					return aiRemoveModel(tx, str(row, "id"))
				}
				if err = tx.remove("ai_cooldown", str(row, "id")); err != nil {
					return err
				}
				return tx.remove(aiKind(kind), str(row, "id"))
			})
			if err != nil {
				return err
			}
			respond(w, 200, Object{"ok": true})
			return nil
		})
	}
	a.aiRoute("POST /api/admin/ai/channels/{id}/test", func(w http.ResponseWriter, r *http.Request) error { return a.aiCheck(w, r, false) })
	a.aiRoute("GET /api/admin/ai/channels/{id}/models", a.aiRemoteModels)
	a.aiRoute("POST /api/admin/ai/models/{id}/check", func(w http.ResponseWriter, r *http.Request) error { return a.aiCheck(w, r, true) })
	a.aiHistoryRoutes()
}

func (a *App) aiSave(w http.ResponseWriter, r *http.Request, kind string, create bool) error {
	b, err := body(r)
	if err != nil {
		return err
	}
	var input Object
	if kind == "channels" {
		input, err = aiChannelInput(b, create)
	} else {
		input, err = aiModelInput(b, create)
	}
	if err != nil {
		return err
	}
	revision := ""
	if !create {
		revision, err = aiText(b["revision"], 64)
		if err != nil {
			return err
		}
	}
	id := r.PathValue("id")
	if create {
		id = uuid()
	}
	if apiKey, present := input["apiKey"]; present {
		material, err := a.aiKey(r.Context(), true)
		if err != nil {
			return err
		}
		input["credential_ciphertext"], err = encryptAICredential(apiKey.(string), id, material)
		if err != nil {
			return err
		}
		delete(input, "apiKey")
	}
	if headers, present := input["headers"]; present {
		material, err := a.aiKey(r.Context(), true)
		if err != nil {
			return err
		}
		names := []string{}
		for name := range object(headers) {
			names = append(names, name)
		}
		sort.Strings(names)
		input["headerNames"] = names
		input["headers_ciphertext"] = ""
		if len(names) > 0 {
			encrypted, err := encryptAICredential(encode(headers), id+":headers", material)
			if err != nil {
				return err
			}
			input["headers_ciphertext"] = encrypted
		}
		delete(input, "headers")
	}
	var saved Object
	err = a.store.mutate(r.Context(), func(tx *transaction) error {
		var previous Object
		if !create {
			var err error
			previous, err = tx.get(aiKind(kind), id)
			if err != nil {
				return err
			}
			if previous == nil {
				return failure("not_found", 404)
			}
			if previous["revision"] != revision {
				return failure("revision_conflict", 409)
			}
		}
		if kind == "models" {
			channel, err := tx.get("ai_channel", str(input, "channelId"))
			if err != nil {
				return err
			}
			if channel == nil {
				return failure("not_found", 404)
			}
			if !validAIModelID(str(channel, "protocol"), str(input, "modelId")) {
				return failure("invalid_ai_model_id", 400)
			}
			if input["request"] == nil {
				input["request"] = aiModelRequestOptions(previous)
			}
		}
		if kind == "channels" {
			if input["notificationChannelIds"] == nil {
				input["notificationChannelIds"] = stringsOf(previous["notificationChannelIds"])
			} else {
				for _, id := range stringsOf(input["notificationChannelIds"]) {
					channel, err := tx.get("notification", id)
					if err != nil {
						return err
					}
					if channel == nil {
						return failure("notification_channel_not_found", 400)
					}
				}
			}
			if input["notificationEnabled"] == nil {
				input["notificationEnabled"] = previous["notificationEnabled"] != false
			}
		}
		if kind == "channels" && input["protocol"] == "gemini" {
			models, err := tx.list("ai_model")
			if err != nil {
				return err
			}
			for _, model := range models {
				if model["channelId"] == id && !validAIModelID("gemini", str(model, "modelId")) {
					return failure("invalid_ai_model_id", 400)
				}
			}
		}
		rows, err := tx.list(aiKind(kind))
		if err != nil {
			return err
		}
		for _, row := range rows {
			if row["id"] == id {
				continue
			}
			if kind == "channels" && row["name"] == input["name"] {
				return failure("duplicate_channel_name", 409)
			}
			if kind == "models" && row["channelId"] == input["channelId"] && (row["name"] == input["name"] || row["modelId"] == input["modelId"]) {
				return failure("duplicate_model", 409)
			}
		}
		now := time.Now().Unix()
		saved = clone(input)
		saved["id"], saved["revision"], saved["createdAt"], saved["updatedAt"] = id, uuid(), now, now
		saved["checkRevision"] = saved["revision"]
		if previous != nil {
			saved["createdAt"] = previous["createdAt"]
			if kind == "channels" && saved["credential_ciphertext"] == nil {
				saved["credential_ciphertext"] = previous["credential_ciphertext"]
			}
		}
		if kind == "channels" && saved["headers_ciphertext"] == nil {
			saved["headers_ciphertext"] = str(previous, "headers_ciphertext")
			saved["headerNames"] = stringsOf(previous["headerNames"])
		}
		if previous != nil {
			changed := false
			fields := []string{"channelId", "modelId", "intervalSec", "timeoutMs"}
			if kind == "channels" {
				fields = []string{"baseUrl", "protocol"}
			} else {
				changed = !reflect.DeepEqual(aiModelRequestOptions(previous), aiModelRequestOptions(saved))
			}
			for _, field := range fields {
				changed = changed || !reflect.DeepEqual(previous[field], saved[field])
			}
			if kind == "channels" && !changed {
				if raw, ok := b["apiKey"].(string); ok {
					key, err := a.decryptAICredential(r.Context(), previous)
					changed = err != nil || key != raw
				}
				if raw, ok := b["headers"]; ok && !changed {
					headers, err := a.decryptAIHeaders(r.Context(), previous)
					nextHeaders, _ := aiHeaders(raw)
					changed = err != nil || !reflect.DeepEqual(headers, nextHeaders)
				}
			}
			if !changed {
				saved["checkRevision"] = previous["checkRevision"]
			}
		}
		return tx.put(aiKind(kind), id, saved)
	})
	if err != nil {
		return err
	}
	status, key := 200, "model"
	if create {
		status = 201
	}
	if kind == "channels" {
		key = "channel"
	}
	view := aiView(kind, saved)
	if kind == "models" {
		view, err = a.aiModelView(r.Context(), saved)
		if err != nil {
			return err
		}
	}
	respond(w, status, Object{key: view})
	return nil
}

func (a *App) aiCheck(w http.ResponseWriter, r *http.Request, modelCheck bool) error {
	enabled, err := a.aiEnabled(r.Context())
	if err != nil {
		return err
	}
	if !enabled {
		return failure("ai_disabled", 409)
	}
	b, err := body(r)
	if err != nil {
		return err
	}
	if modelCheck && b["confirmPaid"] != true {
		return failure("paid_confirmation_required", 400)
	}
	revision, err := aiText(b["revision"], 64)
	if err != nil {
		return err
	}
	channelRevision := revision
	if modelCheck {
		channelRevision, err = aiText(b["channelRevision"], 64)
		if err != nil {
			return err
		}
	}
	var model, channel Object
	read := func(tx *transaction) error {
		var err error
		channelID := r.PathValue("id")
		if modelCheck {
			model, err = tx.get("ai_model", r.PathValue("id"))
			if err != nil {
				return err
			}
			if model == nil {
				return failure("not_found", 404)
			}
			if model["revision"] != revision {
				return failure("revision_conflict", 409)
			}
			channelID = str(model, "channelId")
		}
		channel, err = tx.get("ai_channel", channelID)
		if err != nil {
			return err
		}
		if channel == nil {
			return failure("not_found", 404)
		}
		if channel["revision"] != channelRevision {
			return failure("revision_conflict", 409)
		}
		return nil
	}
	if err = a.store.mutate(r.Context(), read); err != nil {
		return err
	}
	apiKey, err := a.decryptAICredential(r.Context(), channel)
	if err != nil {
		return err
	}
	headers, err := a.decryptAIHeaders(r.Context(), channel)
	if err != nil {
		return err
	}
	config := aiProbeConfig{Headers: headers, Protocol: str(channel, "protocol"), BaseURL: str(channel, "baseUrl"), APIKey: apiKey, TimeoutMS: 10000}
	kind := "channel"
	var result aiProbeResult
	if modelCheck {
		kind, config.Model, config.TimeoutMS = "model", str(model, "modelId"), integer(model, "timeoutMs")
		config.Request = aiModelRequestOptions(model)
		result = probeAIModel(r.Context(), config, a.aiClient)
	} else {
		result = probeAIChannel(r.Context(), config, a.aiClient)
	}
	if err = a.store.mutate(r.Context(), read); err != nil {
		return err
	}
	respond(w, 200, Object{"result": Object{"kind": kind, "checkedAt": time.Now().Unix(), "revision": revision, "channelRevision": channelRevision,
		"outcome": result.Outcome, "statusCode": result.StatusCode, "latencyMs": result.LatencyMS}})
	return nil
}
