package polaris

import (
	"context"
	"net/http"
	"sort"
	"strconv"
	"time"
)

func (a *App) aiHistory(ctx context.Context, id string, days int) (Object, error) {
	now := time.Now().Unix()
	since := now/86400*86400 - int64(days-1)*86400
	floor := time.Unix(since, 0).UTC().Format("2006-01-02")
	rows, err := a.store.db.QueryContext(ctx, a.store.query("SELECT data FROM polaris_documents WHERE kind='ai_day' AND id>=? AND id<? ORDER BY id"), id+":"+floor, id+";")
	if err != nil {
		return nil, err
	}
	byDate := map[string]Object{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			rows.Close()
			return nil, err
		}
		row, err := decodeObject(raw)
		if err != nil {
			rows.Close()
			return nil, err
		}
		if row["modelId"] == id && str(row, "date") >= floor {
			stat := clone(row)
			delete(stat, "id")
			delete(stat, "modelId")
			byDate[str(row, "date")] = stat
		}
	}
	readErr := rows.Err()
	rows.Close()
	if readErr != nil {
		return nil, readErr
	}
	live, err := a.store.get(ctx, "ai_live", id)
	if err != nil {
		return nil, err
	}
	if day := object(live["day"]); day != nil && str(day, "date") >= floor {
		byDate[str(day, "date")] = aiDayStat(day)
	}
	daily := []Object{}
	for _, day := range byDate {
		daily = append(daily, day)
	}
	sort.Slice(daily, func(i, j int) bool { return str(daily[i], "date") < str(daily[j], "date") })
	readings, err := a.readings(ctx, "ai:"+id, since, 100)
	if err != nil {
		return nil, err
	}
	points := []Object{}
	for _, reading := range readings {
		point := Object{}
		for _, key := range []string{"checkedAt", "outcome", "latencyMs", "statusCode", "revision", "channelRevision", "runId"} {
			point[key] = reading.addons[key]
		}
		points = append(points, point)
	}
	return Object{"modelId": id, "days": daily, "points": points, "detailStatus": "ready", "sampled": false}, nil
}
func aiHistoryRange(r *http.Request) (int, error) {
	value := r.URL.Query().Get("days")
	if value == "" {
		return 7, nil
	}
	for _, ch := range value {
		if ch < '0' || ch > '9' {
			return 0, failure("invalid_request", 400)
		}
	}
	n, err := strconv.Atoi(value)
	if err != nil || n < 1 || n > 90 {
		return 0, failure("invalid_request", 400)
	}
	return n, nil
}
func publicAIModel(view Object) Object {
	return Object{"id": view["id"], "name": view["name"], "channel": Object{"id": view["channelId"], "name": view["channelName"]}, "intervalSec": view["intervalSec"], "live": view["live"], "recent": view["recent"]}
}
func (a *App) aiPublicPage(r *http.Request) error {
	kind, enabled, configured, _, err := a.pageContext(r)
	if err != nil {
		return err
	}
	state, err := a.presentation(r.Context())
	if err != nil {
		return err
	}
	cfg := object(state["config"])
	if !boolean(cfg["aiEnabled"]) || kind != "ai" && (kind != "monitor" || !boolean(cfg["aiOnMonitorPage"])) || !enabled || !configured {
		return failure("not_found", 404)
	}
	return nil
}
func (a *App) aiHistoryRoutes() {
	a.aiRoute("GET /api/admin/ai/models/{id}/history", func(w http.ResponseWriter, r *http.Request) error {
		model, err := a.store.get(r.Context(), "ai_model", r.PathValue("id"))
		if err != nil {
			return err
		}
		if model == nil {
			return failure("not_found", 404)
		}
		days, err := aiHistoryRange(r)
		if err != nil {
			return err
		}
		history, err := a.aiHistory(r.Context(), str(model, "id"), days)
		if err != nil {
			return err
		}
		respond(w, 200, history)
		return nil
	})
	a.route("GET /api/public/ai/models", true, func(w http.ResponseWriter, r *http.Request) error {
		if err := a.aiPublicPage(r); err != nil {
			return err
		}
		models, err := a.store.list(r.Context(), "ai_model")
		if err != nil {
			return failure("ai_storage_unavailable", 503)
		}
		views := []Object{}
		public := []Object{}
		for _, model := range models {
			if boolean(model["enabled"]) && boolean(model["isPublic"]) {
				public = append(public, model)
			}
		}
		modelViews, err := a.aiModelViews(r.Context(), public)
		if err != nil {
			return failure("ai_storage_unavailable", 503)
		}
		for _, view := range modelViews {
			views = append(views, publicAIModel(view))
		}
		respond(w, 200, Object{"models": views})
		return nil
	})
	for _, history := range []bool{false, true} {
		path := "GET /api/public/ai/models/{id}"
		if history {
			path += "/history"
		}
		a.route(path, true, func(w http.ResponseWriter, r *http.Request) error {
			if err := a.aiPublicPage(r); err != nil {
				return err
			}
			model, err := a.store.get(r.Context(), "ai_model", r.PathValue("id"))
			if err != nil {
				return failure("ai_storage_unavailable", 503)
			}
			if model == nil || !boolean(model["enabled"]) || !boolean(model["isPublic"]) {
				return failure("not_found", 404)
			}
			if history {
				days, err := aiHistoryRange(r)
				if err != nil {
					return err
				}
				result, err := a.aiHistory(r.Context(), str(model, "id"), days)
				if err != nil {
					return failure("ai_storage_unavailable", 503)
				}
				respond(w, 200, result)
				return nil
			}
			view, err := a.aiModelView(r.Context(), model)
			if err != nil {
				return failure("ai_storage_unavailable", 503)
			}
			respond(w, 200, Object{"model": publicAIModel(view)})
			return nil
		})
	}
}
