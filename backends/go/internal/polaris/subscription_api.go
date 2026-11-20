package polaris

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"
)

func subscriptionText(value any, limit int) (string, error) {
	text, ok := value.(string)
	if !ok || strings.TrimSpace(text) == "" || len(text) > limit || strings.ContainsAny(text, "\r\n\x00") {
		return "", failure("invalid_request", 400)
	}
	return strings.TrimSpace(text), nil
}
func subscriptionInteger(value any, minimum, maximum int64) (int64, error) {
	n, ok := value.(float64)
	if !ok || n != float64(int64(n)) || n < float64(minimum) || n > float64(maximum) {
		return 0, failure("invalid_request", 400)
	}
	return int64(n), nil
}
func subscriptionCategory(value any) (string, error) {
	category, ok := value.(string)
	if !ok || !contains([]string{"website", "model"}, category) {
		return "", failure("invalid_request", 400)
	}
	return category, nil
}
func subscriptionPage(r *http.Request, items []Object) (Object, error) {
	offset, limit := 0, 50
	for key, result := range map[string]*int{"offset": &offset, "limit": &limit} {
		if raw := r.URL.Query().Get(key); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil || n < 0 || (key == "offset" && n > 100000) || (key == "limit" && (n < 1 || n > 200)) {
				return nil, failure("invalid_request", 400)
			}
			*result = n
		}
	}
	var next any
	if offset+limit < len(items) {
		next = offset + limit
	}
	return Object{"items": items[min(offset, len(items)):min(offset+limit, len(items))], "total": len(items), "nextOffset": next}, nil
}
func subscriptionRevision(current, input Object) error {
	if current == nil {
		return failure("not_found", 404)
	}
	if current["revision"] != input["revision"] {
		return failure("revision_conflict", 409)
	}
	return nil
}
func (a *App) subscriptionOwner(r *http.Request) string {
	if user := a.user(r); user != nil {
		return str(user, "id")
	}
	return "admin-token"
}
func (a *App) getSubscription(ctx context.Context, id string) (Object, error) {
	row, err := a.store.get(ctx, "subscription", id)
	if err != nil {
		return nil, err
	}
	if row == nil {
		return nil, failure("not_found", 404)
	}
	return row, nil
}
func (a *App) validateSubscriptionPolicy(ctx context.Context, raw any) (Object, error) {
	input := object(raw)
	enabled, ok := input["notificationEnabled"].(bool)
	if !ok || !validNotificationIDs(input["notificationChannelIds"]) {
		return nil, failure("invalid_request", 400)
	}
	for _, id := range stringsOf(input["notificationChannelIds"]) {
		row, err := a.store.get(ctx, "notification", id)
		if err != nil {
			return nil, err
		}
		if row == nil {
			return nil, failure("notification_channel_not_found", 400)
		}
	}
	return Object{"notificationEnabled": enabled, "notificationChannelIds": input["notificationChannelIds"]}, nil
}
func (a *App) validateSubscriptionNotifications(ctx context.Context, raw any) (Object, error) {
	input := object(raw)
	monitor, err := a.validateSubscriptionPolicy(ctx, input["monitor"])
	if err != nil {
		return nil, err
	}
	sync, err := a.validateSubscriptionPolicy(ctx, input["sync"])
	if err != nil {
		return nil, err
	}
	after, err := subscriptionInteger(object(input["sync"])["afterSec"], 60, 86400)
	if err != nil {
		return nil, err
	}
	sync["afterSec"] = after
	return Object{"monitor": monitor, "sync": sync}, nil
}

func (a *App) subscriptionRoutes() {
	a.subscriptionConfigRoutes()
	a.subscriptionPublicRoutes()
	a.subscriptionIconRoutes()
	a.route("GET /api/admin/subscriptions", false, func(w http.ResponseWriter, r *http.Request) error {
		rows, err := a.store.list(r.Context(), "subscription")
		if err != nil {
			return err
		}
		kind := r.URL.Query().Get("category")
		if kind != "" {
			if _, err := subscriptionCategory(kind); err != nil {
				return err
			}
		}
		items := []Object{}
		selectedCounts, err := a.store.subscriptionSelectedCounts(r.Context())
		if err != nil {
			return err
		}
		summary := Object{"total": int64(0), "items": int64(0), "healthy": int64(0), "partial": int64(0), "failed": int64(0), "paused": int64(0), "archived": int64(0)}
		query := strings.ToLower(r.URL.Query().Get("q"))
		for _, row := range rows {
			if kind != "" && row["category"] != kind || r.URL.Query().Get("archived") != "true" && row["archivedAt"] != nil {
				continue
			}
			state := subscriptionHealth(row)
			summary["total"] = integer(summary, "total") + 1
			summary["items"] = integer(summary, "items") + selectedCounts[str(row, "id")]
			summary[state] = integer(summary, state) + 1
			health := r.URL.Query().Get("health")
			if health != "" && health != "all" && state != health {
				continue
			}
			if !strings.Contains(strings.ToLower(str(row, "name")), query) {
				continue
			}
			items = append(items, row)
		}
		result, err := subscriptionPage(r, items)
		if err != nil {
			return err
		}
		result["summary"] = summary
		dueUpdates := []Object{}
		for _, row := range result["items"].([]Object) {
			_, err := a.subscriptionStatusView(r.Context(), row)
			if err != nil {
				return err
			}
			update, err := a.store.get(r.Context(), "subscription_update", str(row, "configId"))
			if err != nil {
				return err
			}
			if update != nil {
				view := clone(update)
				delete(view, "candidate")
				delete(view, "subscriptionId")
				row["configUpdate"] = view
			}
			if str(row, "sourceUrl") != "" && (update == nil || time.Now().Unix()-integer(update, "checkedAt") >= 86400) {
				dueUpdates = append(dueUpdates, clone(row))
			}
		}
		a.scheduleSubscriptionUpdates(dueUpdates)
		respond(w, 200, result)
		return nil
	})
	a.route("POST /api/admin/subscriptions", false, a.createSubscription)
	a.route("GET /api/admin/subscriptions/{id}", false, func(w http.ResponseWriter, r *http.Request) error {
		row, err := a.getSubscription(r.Context(), r.PathValue("id"))
		if err != nil {
			return err
		}
		row, err = a.subscriptionStatusView(r.Context(), row)
		if err != nil {
			return err
		}
		respond(w, 200, Object{"subscription": row})
		return nil
	})
	a.route("PATCH /api/admin/subscriptions/{id}", false, a.patchSubscription)
	a.route("DELETE /api/admin/subscriptions/{id}", false, a.deleteSubscription)
	a.route("GET /api/admin/subscriptions/{id}/items", false, func(w http.ResponseWriter, r *http.Request) error {
		subscription, err := a.getSubscription(r.Context(), r.PathValue("id"))
		if err != nil {
			return err
		}
		rows, err := a.store.subscriptionItemIndex(r.Context(), r.PathValue("id"), false)
		if err != nil {
			return err
		}
		items := []Object{}
		state, query := r.URL.Query().Get("state"), strings.ToLower(r.URL.Query().Get("q"))
		for _, row := range rows {
			if state == "selected" && (!boolean(row["selected"]) || row["removedAt"] != nil) || state == "discovered" && (boolean(row["selected"]) || row["removedAt"] != nil) || state == "removed" && row["removedAt"] == nil {
				continue
			}
			name := str(row, "localName")
			if name == "" {
				name = str(row, "name")
			}
			if !strings.Contains(strings.ToLower(name), query) {
				continue
			}
			items = append(items, subscriptionItemView(row, subscription, time.Now().Unix()))
		}
		sortSubscriptionItems(items)
		result, err := subscriptionPage(r, items)
		if err != nil {
			return err
		}
		full, err := a.store.subscriptionItemsByIndex(r.Context(), result["items"].([]Object))
		if err != nil {
			return err
		}
		for i, item := range full {
			full[i] = subscriptionItemView(item, subscription, time.Now().Unix())
		}
		result["items"] = full
		respond(w, 200, result)
		return nil
	})
	a.route("PATCH /api/admin/subscriptions/{id}/items", false, a.patchSubscriptionItems)
	a.route("GET /api/admin/subscriptions/{id}/items/{itemId}/history", false, func(w http.ResponseWriter, r *http.Request) error {
		row, err := a.store.get(r.Context(), "subscription_item", r.PathValue("itemId"))
		if err != nil {
			return err
		}
		if row == nil || row["subscriptionId"] != r.PathValue("id") {
			return failure("not_found", 404)
		}
		respond(w, 200, subscriptionHistory(row))
		return nil
	})
	a.route("POST /api/admin/subscriptions/{id}/sync", false, func(w http.ResponseWriter, r *http.Request) error {
		run, err := a.runSubscription(r.Context(), r.PathValue("id"), true, true)
		if err != nil {
			return err
		}
		respond(w, 202, Object{"run": run, "runId": run["id"]})
		return nil
	})
	a.route("GET /api/admin/subscriptions/{id}/runs", false, func(w http.ResponseWriter, r *http.Request) error {
		if _, err := a.getSubscription(r.Context(), r.PathValue("id")); err != nil {
			return err
		}
		rows, err := a.store.subscriptionDocuments(r.Context(), a.store.db, "subscription_run", r.PathValue("id"))
		if err != nil {
			return err
		}
		runs := []Object{}
		for _, row := range rows {
			if row["subscriptionId"] == r.PathValue("id") && integer(row, "expiresAt") > time.Now().Unix() {
				runs = append(runs, a.subscriptionRunView(r.Context(), row))
			}
		}
		respond(w, 200, Object{"runs": runs})
		return nil
	})
	a.route("GET /api/admin/subscription-runs/{runId}", false, func(w http.ResponseWriter, r *http.Request) error {
		run, err := a.store.get(r.Context(), "subscription_run", r.PathValue("runId"))
		if err != nil {
			return err
		}
		if run == nil || integer(run, "expiresAt") <= time.Now().Unix() {
			return failure("not_found", 404)
		}
		respond(w, 200, Object{"run": a.subscriptionRunView(r.Context(), run)})
		return nil
	})
}

func (a *App) createSubscription(w http.ResponseWriter, r *http.Request) error {
	input, err := body(r)
	if err != nil {
		return err
	}
	requestID, err := subscriptionText(input["requestId"], 64)
	if err != nil {
		return err
	}
	owner := a.subscriptionOwner(r)
	previous, err := a.store.get(r.Context(), "subscription_create", requestID)
	if err != nil {
		return err
	}
	if previous != nil {
		if previous["owner"] != owner {
			return failure("revision_conflict", 409)
		}
		row, err := a.getSubscription(r.Context(), str(previous, "subscriptionId"))
		if err != nil {
			return err
		}
		respond(w, 200, Object{"subscription": row})
		return nil
	}
	preview, err := a.validSubscriptionPreview(r, str(input, "previewId"))
	if err != nil {
		return err
	}
	if !contains([]string{"ready", "partial"}, str(preview, "state")) {
		return failure("subscription_preview_expired", 409)
	}
	kind, err := subscriptionCategory(input["category"])
	if err != nil {
		return err
	}
	config := object(preview["config"])
	descriptor := object(config["descriptor"])
	if !contains(stringsOf(descriptor["categories"]), kind) {
		return failure("subscription_category_invalid", 400)
	}
	if kind == "model" {
		enabled, err := a.aiEnabled(r.Context())
		if err != nil {
			return err
		}
		if !enabled {
			return failure("ai_disabled", 409)
		}
	}
	selected, ok := input["selectedIds"].([]any)
	if !ok || len(selected) == 0 || len(selected) > 1000 {
		return failure("subscription_selection_invalid", 400)
	}
	available := map[string]bool{}
	for _, raw := range array(preview["items"]) {
		item := object(raw)
		id := str(item, "sourceItemId")
		valid := item["observation"] != nil
		for _, rawIssue := range array(preview["issues"]) {
			if object(rawIssue)["itemId"] == id {
				valid = false
			}
		}
		available[id] = valid
	}
	chosen := map[string]bool{}
	for _, raw := range selected {
		id, ok := raw.(string)
		if !ok || !available[id] || chosen[id] {
			return failure("subscription_selection_invalid", 400)
		}
		chosen[id] = true
	}
	name, err := subscriptionText(input["name"], 120)
	if err != nil {
		return err
	}
	stamp, id, revision := time.Now().Unix(), uuid(), uuid()
	row := Object{"id": id, "name": name, "category": kind, "enabled": true, "archivedAt": nil, "isPublic": false, "autoSubscribe": false, "intervalSec": 60, "staleAfterSec": 300, "revision": revision, "syncRevision": revision, "createdAt": stamp, "updatedAt": stamp, "notifications": subscriptionDefaultNotifications(), "runtime": subscriptionInitialRuntime()}
	for _, field := range []string{"isPublic", "autoSubscribe"} {
		if value, exists := input[field]; exists {
			if _, ok := value.(bool); !ok {
				return failure("invalid_request", 400)
			}
			row[field] = value
		}
	}
	for key, maximum := range map[string]int64{"intervalSec": 86400, "staleAfterSec": 604800} {
		if value, exists := input[key]; exists {
			n, err := subscriptionInteger(value, 60, maximum)
			if err != nil {
				return err
			}
			row[key] = n
		}
	}
	if supplied, exists := input["notifications"]; exists {
		policy, err := a.validateSubscriptionNotifications(r.Context(), supplied)
		if err != nil {
			return err
		}
		row["notifications"] = policy
	}
	config, err = a.configFromSubscriptionPreview(r.Context(), preview)
	if err != nil {
		return err
	}
	config["subscriptionId"] = id
	row["configId"], row["templateName"], row["templateVersion"], row["sourceUrl"], row["origin"] = config["id"], descriptor["name"], descriptor["version"], config["sourceUrl"], config["origin"]
	row["sourceHosts"] = subscriptionSourceHosts(config)
	row["sourcePageUrl"] = subscriptionSourcePage(config)
	object(row["runtime"])["itemCount"], object(row["runtime"])["selectedCount"] = len(available), len(chosen)
	err = a.store.mutate(r.Context(), func(tx *transaction) error {
		replay, err := tx.get("subscription_create", requestID)
		if err != nil {
			return err
		}
		if replay != nil {
			if replay["owner"] != owner {
				return failure("revision_conflict", 409)
			}
			row, err = tx.get("subscription", str(replay, "subscriptionId"))
			return err
		}
		if err := tx.put("subscription", id, row); err != nil {
			return err
		}
		if err := tx.put("subscription_config", str(config, "id"), config); err != nil {
			return err
		}
		groupID := str(input, "groupId")
		if groupID != "" {
			group, err := tx.get("group", groupID)
			if err != nil {
				return err
			}
			if group == nil || row["category"] != "website" {
				return failure("group_not_found", 400)
			}
		}
		for _, raw := range array(preview["items"]) {
			source := object(raw)
			item := mergeSubscriptionItem(newSubscriptionItem(source, row, chosen[str(source, "sourceItemId")]), source, revision, stamp)
			if groupID != "" {
				item["groupId"] = groupID
			}
			item["isPublic"], item["baseline"], item["announced"] = boolean(row["isPublic"]) && boolean(item["selected"]), true, object(item["observation"])["status"]
			if err := tx.put("subscription_item", str(item, "id"), item); err != nil {
				return err
			}
		}
		return tx.put("subscription_create", requestID, Object{"id": requestID, "subscriptionId": id, "owner": owner, "expiresAt": stamp + 86400})
	})
	if err != nil {
		return err
	}
	respond(w, 201, Object{"subscription": row})
	return nil
}

func (a *App) patchSubscription(w http.ResponseWriter, r *http.Request) error {
	input, err := body(r)
	if err != nil {
		return err
	}
	changes := Object{}
	if value, exists := input["name"]; exists {
		name, err := subscriptionText(value, 120)
		if err != nil {
			return err
		}
		changes["name"] = name
	}
	for _, key := range []string{"enabled", "isPublic", "autoSubscribe", "archived"} {
		if value, exists := input[key]; exists {
			if _, ok := value.(bool); !ok {
				return failure("invalid_request", 400)
			}
			changes[key] = value
		}
	}
	for key, maximum := range map[string]int64{"intervalSec": 86400, "staleAfterSec": 604800} {
		if value, exists := input[key]; exists {
			n, err := subscriptionInteger(value, 60, maximum)
			if err != nil {
				return err
			}
			changes[key] = n
		}
	}
	if value, exists := input["notifications"]; exists {
		policy, err := a.validateSubscriptionNotifications(r.Context(), value)
		if err != nil {
			return err
		}
		changes["notifications"] = policy
	}
	var result Object
	err = a.store.mutate(r.Context(), func(tx *transaction) error {
		row, err := tx.get("subscription", r.PathValue("id"))
		if err != nil {
			return err
		}
		if err := subscriptionRevision(row, input); err != nil {
			return err
		}
		invalidate := false
		for key, value := range changes {
			if contains([]string{"enabled", "intervalSec", "staleAfterSec"}, key) && fmt.Sprint(row[key]) != fmt.Sprint(value) {
				invalidate = true
			}
			if key != "archived" {
				row[key] = value
			}
		}
		if value, exists := changes["archived"]; exists {
			row["archivedAt"] = nil
			if value == true {
				row["archivedAt"], row["enabled"] = time.Now().Unix(), false
			}
			invalidate = true
		}
		row["revision"], row["updatedAt"] = uuid(), time.Now().Unix()
		if invalidate {
			row["syncRevision"] = uuid()
			object(row["runtime"])["nextDueAt"] = time.Now().Unix()
		}
		result = row
		return tx.put("subscription", str(row, "id"), row)
	})
	if err != nil {
		return err
	}
	respond(w, 200, Object{"subscription": result})
	return nil
}

func (a *App) patchSubscriptionItems(w http.ResponseWriter, r *http.Request) error {
	input, err := body(r)
	if err != nil {
		return err
	}
	if _, err := a.getSubscription(r.Context(), r.PathValue("id")); err != nil {
		return err
	}
	updates, ok := input["items"].([]any)
	if !ok || len(updates) > 100 {
		return failure("invalid_request", 400)
	}
	results := []Object{}
	for _, raw := range updates {
		update := object(raw)
		id, err := subscriptionText(update["id"], 64)
		if err != nil {
			return err
		}
		var result Object
		err = a.store.mutate(r.Context(), func(tx *transaction) error {
			row, err := tx.get("subscription_item", id)
			if err != nil {
				return err
			}
			if row == nil || row["subscriptionId"] != r.PathValue("id") {
				return failure("not_found", 404)
			}
			if err := subscriptionRevision(row, update); err != nil {
				return err
			}
			for _, field := range []string{"selected", "isPublic", "muted"} {
				if value, exists := update[field]; exists {
					if _, ok := value.(bool); !ok {
						return failure("invalid_request", 400)
					}
					if field == "selected" && row[field] != value {
						row["baseline"] = false
					}
					row[field] = value
				}
			}
			if value, exists := update["localName"]; exists {
				row["localName"] = nil
				if value != nil && value != "" {
					name, err := subscriptionText(value, 120)
					if err != nil {
						return err
					}
					row["localName"] = name
				}
			}
			if value, exists := update["groupId"]; exists {
				row["groupId"] = nil
				if value != nil {
					groupID, err := subscriptionText(value, 64)
					if err != nil {
						return err
					}
					group, err := tx.get("group", groupID)
					if err != nil {
						return err
					}
					if group == nil {
						return failure("group_not_found", 400)
					}
					row["groupId"] = groupID
				}
			}
			if value, exists := update["sortOrder"]; exists {
				n, err := subscriptionInteger(value, 0, 100000)
				if err != nil {
					return err
				}
				row["sortOrder"] = n
			}
			row["revision"] = uuid()
			result = row
			return tx.put("subscription_item", id, row)
		})
		if err != nil {
			results = append(results, Object{"id": id, "ok": false, "error": err.Error()})
		} else {
			results = append(results, Object{"id": id, "ok": true, "item": result})
		}
	}
	respond(w, 200, Object{"results": results})
	return nil
}

func (a *App) deleteSubscription(w http.ResponseWriter, r *http.Request) error {
	input, err := body(r)
	if err != nil {
		return err
	}
	id := r.PathValue("id")
	err = a.store.mutate(r.Context(), func(tx *transaction) error {
		row, err := tx.get("subscription", id)
		if err != nil {
			return err
		}
		if err := subscriptionRevision(row, input); err != nil {
			return err
		}
		if _, err := tx.tx.ExecContext(r.Context(), tx.store.query("DELETE FROM polaris_documents WHERE kind IN ('subscription_item','subscription_config','subscription_previous','subscription_run','subscription_cache','subscription_create','subscription_preview','subscription_checkpoint','subscription_normalized','subscription_update','subscription_icon') AND "+tx.store.jsonField("subscriptionId")+"=?"), id); err != nil {
			return err
		}
		for _, kind := range []string{"outbox"} {
			rows, err := tx.list(kind)
			if err != nil {
				return err
			}
			for _, row := range rows {
				if row["subscriptionId"] == id || kind == "outbox" && object(row["event"])["subscriptionId"] == id {
					if err := tx.remove(kind, str(row, "id")); err != nil {
						return err
					}
				}
			}
		}
		if _, err := tx.tx.ExecContext(r.Context(), tx.store.query("DELETE FROM polaris_leases WHERE id=?"), "subscription:"+id); err != nil {
			return err
		}
		return tx.remove("subscription", id)
	})
	if err != nil {
		return err
	}
	respond(w, 200, Object{"ok": true})
	return nil
}

func subscriptionHistory(item Object) Object {
	return Object{"days": item["days"], "recent": item["recent"], "availability": item["availability"], "mode": item["mode"]}
}
