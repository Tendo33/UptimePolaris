package polaris

import (
	"context"
	"net/http"
	"strings"
)

func notificationRoutingReason(channel, event Object) string {
	if event["notificationEnabled"] == false {
		return "notifications_disabled"
	}
	if channel["active"] != nil && !boolean(channel["active"]) {
		return "channel_inactive"
	}
	ids := stringsOf(event["notificationChannelIds"])
	if len(ids) > 0 {
		if contains(ids, str(channel, "id")) {
			return ""
		}
		return "channel_not_selected"
	}
	kind := str(event, "eventKind")
	if kind == "" {
		kind = "monitor_state"
		if str(event, "aiModelId") != "" || event["monitorType"] == "ai" {
			kind = "ai_state"
		} else if strings.HasPrefix(str(event, "eventKey"), "resource:") {
			kind = "agent_resource"
		}
	}
	source := str(event, "sourceType")
	if source == "" {
		source = "local"
		if str(event, "subscriptionId") != "" {
			source = "subscription"
		}
	}
	kinds := stringsOf(channel["event_kinds"])
	if channel["event_kinds"] == nil {
		kinds = []string{"monitor_state", "ai_state", "agent_resource"}
	}
	sources := stringsOf(channel["source_types"])
	if channel["source_types"] == nil {
		sources = []string{"local"}
	}
	if !contains(kinds, kind) {
		return "event_outside_scope"
	}
	if !contains(sources, source) {
		return "source_outside_scope"
	}
	if groups := stringsOf(channel["group_ids"]); len(groups) > 0 && !contains(groups, str(event, "groupId")) {
		return "group_outside_scope"
	}
	return ""
}

func (a *App) notificationResolve(w http.ResponseWriter, r *http.Request) error {
	event, err := body(r)
	if err != nil {
		return err
	}
	channels, err := a.store.list(r.Context(), "notification")
	if err != nil {
		return err
	}
	settings, err := a.settings(r.Context())
	if err != nil {
		return err
	}
	suppressed := boolean(maintenance(settings)["active"])
	results := []Object{}
	for _, channel := range channels {
		reason := notificationRoutingReason(channel, event)
		if reason == "" && suppressed {
			reason = "notifications_suppressed"
		}
		var why any
		if reason != "" {
			why = reason
		}
		results = append(results, Object{"id": channel["id"], "name": channel["name"], "reason": why})
	}
	respond(w, 200, Object{"channels": results, "suppressed": suppressed})
	return nil
}

func (a *App) subscriptionNotificationCurrent(ctx context.Context, event Object, channel Object) (bool, error) {
	subscription, err := a.store.get(ctx, "subscription", str(event, "subscriptionId"))
	if err != nil {
		return false, err
	}
	if subscription == nil || !boolean(subscription["enabled"]) || subscription["archivedAt"] != nil || subscription["syncRevision"] != event["syncRevision"] {
		return false, nil
	}
	if subscription["category"] == "model" {
		enabled, err := a.aiEnabled(ctx)
		if err != nil || !enabled {
			return false, err
		}
	}
	policyKey := "monitor"
	if event["eventKind"] == "subscription_sync" {
		policyKey = "sync"
	}
	policy := object(object(subscription["notifications"])[policyKey])
	event["notificationEnabled"], event["notificationChannelIds"] = policy["notificationEnabled"], policy["notificationChannelIds"]
	if id := str(event, "subscriptionItemId"); id != "" {
		item, err := a.store.get(ctx, "subscription_item", id)
		if err != nil {
			return false, err
		}
		if item == nil || !boolean(item["selected"]) || boolean(item["muted"]) || item["removedAt"] != nil {
			return false, nil
		}
		if item["category"] == "website" {
			event["groupId"] = item["groupId"]
		}
	}
	return notificationRoutingReason(channel, event) == "", nil
}
