package polaris

import (
	"context"
	"sort"
	"sync"
	"time"
)

func aiPercent(ok, total int64) any {
	if total == 0 {
		return nil
	}
	return float64(ok) * 100 / float64(total)
}
func aiDayStat(day Object) Object {
	total, ok := integer(day, "total"), integer(day, "ok")
	var avg any
	if total > 0 {
		avg = number(day["latencyTotalMs"]) / float64(total)
	}
	return Object{"date": day["date"], "total": total, "ok": ok, "availabilityPct": aiPercent(ok, total), "avgLatencyMs": avg, "exact": true}
}
func aiRuntimeEntry(model, channel, previous Object) Object {
	if previous != nil && previous["revision"] == model["checkRevision"] && previous["channelRevision"] == channel["checkRevision"] {
		return clone(previous)
	}
	return Object{"modelId": model["id"], "checkedAt": 0, "outcome": "invalid_config", "latencyMs": 0, "statusCode": 0, "revision": model["checkRevision"], "channelRevision": channel["checkRevision"], "runId": "",
		"nextCheckAt": 0, "lastAttemptAt": 0, "skipReason": nil, "total": integer(previous, "total"), "ok": integer(previous, "ok"), "consecutiveFailures": 0, "settled": "up", "announced": "up", "alertPending": false, "recent": []any{}, "day": previous["day"]}
}
func aiLiveView(model, channel, previous Object, now int64) Object {
	entry := aiRuntimeEntry(model, channel, previous)
	freshness := "current"
	if !boolean(model["enabled"]) {
		freshness = "paused"
	} else if previous != nil && (previous["revision"] != model["checkRevision"] || previous["channelRevision"] != channel["checkRevision"]) {
		freshness = "configuration_changed"
	} else if integer(entry, "checkedAt") == 0 {
		freshness = "never_checked"
	} else if now > integer(entry, "checkedAt")+integer(model, "intervalSec")*2 {
		freshness = "stale"
	}
	view := Object{"checkedAt": nil, "outcome": nil, "latencyMs": nil, "statusCode": entry["statusCode"], "revision": model["checkRevision"], "channelRevision": channel["checkRevision"], "runId": nil,
		"nextCheckAt": entry["nextCheckAt"], "lastAttemptAt": nil, "skipReason": entry["skipReason"], "freshness": freshness, "total": integer(entry, "total"), "ok": integer(entry, "ok"), "availabilityPct": aiPercent(integer(entry, "ok"), integer(entry, "total")), "consecutiveFailures": entry["consecutiveFailures"]}
	if integer(entry, "checkedAt") > 0 {
		for _, field := range []string{"checkedAt", "outcome", "latencyMs", "runId"} {
			view[field] = entry[field]
		}
	}
	if integer(entry, "lastAttemptAt") > 0 {
		view["lastAttemptAt"] = entry["lastAttemptAt"]
	}
	return view
}
func (a *App) aiModelView(ctx context.Context, model Object) (Object, error) {
	channel, err := a.store.get(ctx, "ai_channel", str(model, "channelId"))
	if err != nil {
		return nil, err
	}
	live, err := a.store.get(ctx, "ai_live", str(model, "id"))
	if err != nil {
		return nil, err
	}
	return aiModelViewWithLive(model, channel, live, time.Now().Unix()), nil
}
func aiModelViewWithLive(model, channel, live Object, now int64) Object {
	view := aiView("models", model)
	view["channelName"] = channel["name"]
	view["live"] = aiLiveView(model, channel, live, now)
	view["recent"] = array(aiRuntimeEntry(model, channel, live)["recent"])
	return view
}
func (a *App) aiModelViews(ctx context.Context, models []Object) ([]Object, error) {
	channels, err := a.store.list(ctx, "ai_channel")
	if err != nil {
		return nil, err
	}
	entries, err := a.store.list(ctx, "ai_live")
	if err != nil {
		return nil, err
	}
	byChannel, byModel := map[string]Object{}, map[string]Object{}
	for _, channel := range channels {
		byChannel[str(channel, "id")] = channel
	}
	for _, entry := range entries {
		byModel[str(entry, "modelId")] = entry
	}
	views := []Object{}
	now := time.Now().Unix()
	for _, model := range models {
		channel := byChannel[str(model, "channelId")]
		if channel == nil {
			continue
		}
		views = append(views, aiModelViewWithLive(model, channel, byModel[str(model, "id")], now))
	}
	return views, nil
}
func aiRemoveModel(tx *transaction, id string) error {
	for _, kind := range []string{"ai_model", "ai_live"} {
		if err := tx.remove(kind, id); err != nil {
			return err
		}
	}
	days, err := tx.list("ai_day")
	if err != nil {
		return err
	}
	for _, day := range days {
		if day["modelId"] == id {
			if err = tx.remove("ai_day", str(day, "id")); err != nil {
				return err
			}
		}
	}
	_, err = tx.tx.Exec(tx.store.query(`DELETE FROM polaris_readings WHERE monitor_id=?`), "ai:"+id)
	return err
}

func (a *App) aiCycle(ctx context.Context, wait bool) {
	enabled, enabledErr := a.aiEnabled(ctx)
	if enabledErr != nil || !enabled {
		return
	}
	channels, err := a.store.list(ctx, "ai_channel")
	if err != nil || len(channels) == 0 {
		return
	}
	models, err := a.store.list(ctx, "ai_model")
	if err != nil {
		return
	}
	liveRows, err := a.store.list(ctx, "ai_live")
	if err != nil {
		return
	}
	liveByModel := map[string]Object{}
	for _, entry := range liveRows {
		liveByModel[str(entry, "modelId")] = entry
	}
	now := time.Now().Unix()
	var wg sync.WaitGroup
	for _, channel := range channels {
		candidates := []Object{}
		for _, model := range models {
			if boolean(model["enabled"]) && model["channelId"] == channel["id"] {
				entry := liveByModel[str(model, "id")]
				if entry != nil && entry["revision"] == model["checkRevision"] && entry["channelRevision"] == channel["checkRevision"] && integer(entry, "nextCheckAt") > now && !boolean(entry["alertPending"]) {
					continue
				}
				candidates = append(candidates, model)
			}
		}
		if len(candidates) == 0 {
			continue
		}
		sort.Slice(candidates, func(i, j int) bool {
			left, right := integer(liveByModel[str(candidates[i], "id")], "nextCheckAt"), integer(liveByModel[str(candidates[j], "id")], "nextCheckAt")
			if left != right {
				return left < right
			}
			return str(candidates[i], "id") < str(candidates[j], "id")
		})
		if wait {
			select {
			case a.semaphore <- struct{}{}:
			case <-ctx.Done():
				return
			}
		} else {
			select {
			case a.semaphore <- struct{}{}:
			default:
				continue
			}
		}
		a.wg.Add(1)
		wg.Add(1)
		store := a.store
		go func(channel Object, models []Object) {
			defer a.wg.Done()
			defer wg.Done()
			defer func() { <-a.semaphore }()
			if !wait {
				a.storeLock.RLock()
				defer a.storeLock.RUnlock()
				if a.store != store {
					return
				}
			}
			owner := token(16)
			lease := "ai-channel:" + str(channel, "id")
			claimed, err := store.claim(ctx, lease, owner, time.Now().Unix(), 90, true)
			if err != nil || !claimed {
				return
			}
			defer store.release(context.Background(), lease, owner, 0)
			for _, model := range models {
				if ctx.Err() != nil {
					return
				}
				renewed, err := store.db.ExecContext(ctx, store.query(`UPDATE polaris_leases SET expires_at=? WHERE id=? AND owner=? AND expires_at>?`), time.Now().Unix()+90, lease, owner, time.Now().Unix())
				if err != nil {
					return
				}
				n, _ := renewed.RowsAffected()
				if n != 1 {
					return
				}
				_ = a.executeAI(ctx, model, channel, owner)
			}
		}(channel, candidates)
	}
	if wait {
		wg.Wait()
	}
}

func aiGuard(tx *transaction, model, channel Object, owner string) error {
	var leaseOwner string
	var expires int64
	query := `SELECT owner,expires_at FROM polaris_leases WHERE id=?`
	if tx.store.postgres {
		query += " FOR UPDATE"
	}
	err := tx.tx.QueryRow(tx.store.query(query), "ai-channel:"+str(channel, "id")).Scan(&leaseOwner, &expires)
	if err != nil {
		return err
	}
	if leaseOwner != owner || expires <= time.Now().Unix() {
		return failure("ai_lease_lost", 409)
	}
	current, err := tx.get("ai_model", str(model, "id"))
	if err != nil {
		return err
	}
	parent, err := tx.get("ai_channel", str(channel, "id"))
	if err != nil {
		return err
	}
	if current == nil || parent == nil || !boolean(current["enabled"]) || current["revision"] != model["revision"] || parent["revision"] != channel["revision"] {
		return failure("revision_conflict", 409)
	}
	return nil
}
func aiBackoff(outcome string, interval, retry int64) int64 {
	if contains([]string{"authentication_failed", "permission_denied", "quota_exhausted"}, outcome) {
		return max(interval, 3600)
	}
	if contains([]string{"rate_limited", "rate_limit_or_quota"}, outcome) {
		if retry <= 0 {
			retry = 900
		}
		return max(interval, retry)
	}
	return 0
}
func aiNextCheckAt(now, delay int64) int64 {
	const maximum = int64(9007199254740991)
	if delay > maximum-now {
		return maximum
	}
	return now + delay
}
func (a *App) aiAlert(tx *transaction, model, channel, entry Object, suppressed bool, now int64) error {
	if suppressed || !boolean(entry["alertPending"]) || integer(entry, "checkedAt") == 0 || now > integer(entry, "checkedAt")+integer(model, "intervalSec")*2 {
		return nil
	}
	m := Object{"id": "ai:" + str(model, "id"), "_aiModelId": model["id"], "name": model["name"], "target": model["name"], "type": "ai", "revision": model["checkRevision"], "_aiChannelRevision": channel["checkRevision"], "notificationChannelIds": channel["notificationChannelIds"], "notificationEnabled": channel["notificationEnabled"] != false, "aiChannelId": channel["id"]}
	status, previous := 1, 1
	if entry["settled"] == "down" {
		status = 0
	}
	if entry["announced"] == "down" {
		previous = 0
	}
	_, err := a.queueNotifications(tx, m, Object{"st": status, "prev_st": previous, "msg": entry["outcome"], "code": entry["statusCode"], "v": entry["latencyMs"], "ts": now, "runId": entry["runId"]})
	if err != nil {
		return err
	}
	entry["announced"], entry["alertPending"] = entry["settled"], false
	return nil
}
func (a *App) executeAI(ctx context.Context, model, channel Object, owner string) error {
	if enabled, err := a.aiEnabled(ctx); err != nil || !enabled {
		return err
	}
	now := time.Now().Unix()
	var entry Object
	due := false
	settings, err := a.settings(ctx)
	if err != nil {
		return err
	}
	suppressed := boolean(maintenance(settings)["active"])
	err = a.store.mutate(ctx, func(tx *transaction) error {
		if err := aiGuard(tx, model, channel, owner); err != nil {
			return err
		}
		previous, err := tx.get("ai_live", str(model, "id"))
		if err != nil {
			return err
		}
		entry = aiRuntimeEntry(model, channel, previous)
		if err = a.aiAlert(tx, model, channel, entry, suppressed, now); err != nil {
			return err
		}
		if integer(entry, "nextCheckAt") > now {
			if boolean(previous["alertPending"]) && !boolean(entry["alertPending"]) {
				return tx.put("ai_live", str(model, "id"), entry)
			}
			return nil
		}
		cooldown, err := tx.get("ai_cooldown", str(channel, "id"))
		if err != nil {
			return err
		}
		if cooldown["revision"] == channel["checkRevision"] && integer(cooldown, "nextAllowedAt") > now {
			entry["lastAttemptAt"], entry["skipReason"], entry["nextCheckAt"] = now, "channel_backoff", cooldown["nextAllowedAt"]
			return tx.put("ai_live", str(model, "id"), entry)
		}
		due = true
		return nil
	})
	if err != nil || !due {
		return err
	}
	apiKey, err := a.decryptAICredential(ctx, channel)
	var headers Object
	if err == nil {
		headers, err = a.decryptAIHeaders(ctx, channel)
	}
	if err != nil {
		return a.store.mutate(ctx, func(tx *transaction) error {
			if err := aiGuard(tx, model, channel, owner); err != nil {
				return err
			}
			entry["lastAttemptAt"], entry["skipReason"], entry["nextCheckAt"] = now, "credential_unavailable", now+integer(model, "intervalSec")
			return tx.put("ai_live", str(model, "id"), entry)
		})
	}
	result := probeAIModel(ctx, aiProbeConfig{Headers: headers, Request: aiModelRequestOptions(model), Protocol: str(channel, "protocol"), BaseURL: str(channel, "baseUrl"), APIKey: apiKey, Model: str(model, "modelId"), TimeoutMS: integer(model, "timeoutMs")}, a.aiClient)
	if ctx.Err() != nil {
		return ctx.Err()
	}
	now = time.Now().Unix()
	runID := uuid()
	return a.store.mutate(ctx, func(tx *transaction) error {
		if err := aiGuard(tx, model, channel, owner); err != nil {
			return err
		}
		previous, err := tx.get("ai_live", str(model, "id"))
		if err != nil {
			return err
		}
		entry = aiRuntimeEntry(model, channel, previous)
		if integer(entry, "checkedAt") > now {
			return nil
		}
		if result.Outcome == "invalid_config" {
			entry["lastAttemptAt"], entry["skipReason"], entry["nextCheckAt"] = now, "configuration_invalid", now+integer(model, "intervalSec")
			return tx.put("ai_live", str(model, "id"), entry)
		}
		date := time.Unix(now, 0).UTC().Format("2006-01-02")
		day := object(entry["day"])
		if day != nil && day["date"] != date {
			if err = putAIDay(tx, str(model, "id"), day); err != nil {
				return err
			}
			day = nil
		}
		if day == nil {
			day = Object{"date": date, "total": 0, "ok": 0, "latencyTotalMs": 0}
		}
		entry["checkedAt"], entry["outcome"], entry["latencyMs"], entry["statusCode"], entry["runId"] = now, result.Outcome, result.LatencyMS, result.StatusCode, runID
		recent := append(array(entry["recent"]), Object{"checkedAt": now, "outcome": result.Outcome, "latencyMs": result.LatencyMS, "statusCode": result.StatusCode})
		if len(recent) > 60 {
			recent = recent[len(recent)-60:]
		}
		entry["recent"] = recent
		entry["lastAttemptAt"], entry["nextCheckAt"], entry["skipReason"] = now, now+integer(model, "intervalSec"), nil
		entry["total"], day["total"], day["latencyTotalMs"] = integer(entry, "total")+1, integer(day, "total")+1, number(day["latencyTotalMs"])+result.LatencyMS
		status := 0
		if result.Outcome == "ok" {
			status = 1
			entry["ok"], day["ok"], entry["consecutiveFailures"], entry["settled"] = integer(entry, "ok")+1, integer(day, "ok")+1, 0, "up"
		} else {
			entry["consecutiveFailures"] = integer(entry, "consecutiveFailures") + 1
			if integer(entry, "consecutiveFailures") >= max(1, int64(number(settings["monitor.defaultRetries"]))) {
				entry["settled"] = "down"
			}
		}
		entry["day"], entry["alertPending"] = day, entry["settled"] != entry["announced"]
		backoff := aiBackoff(result.Outcome, integer(model, "intervalSec"), result.RetryAfterSec)
		if backoff > 0 {
			entry["nextCheckAt"] = aiNextCheckAt(now, backoff)
			if result.Outcome != "permission_denied" {
				if err = tx.put("ai_cooldown", str(channel, "id"), Object{"revision": channel["checkRevision"], "nextAllowedAt": aiNextCheckAt(now, backoff)}); err != nil {
					return err
				}
			}
		}
		if err = a.aiAlert(tx, model, channel, entry, suppressed, now); err != nil {
			return err
		}
		point := Object{}
		for _, field := range []string{"checkedAt", "outcome", "latencyMs", "statusCode", "runId", "revision", "channelRevision"} {
			point[field] = entry[field]
		}
		if _, err = tx.tx.Exec(tx.store.query(`INSERT INTO polaris_readings(monitor_id,ts,status,value,code,message,addons) VALUES(?,?,?,?,?,?,?)`), "ai:"+str(model, "id"), now, status, result.LatencyMS, result.StatusCode, result.Outcome, encode(point)); err != nil {
			return err
		}
		return tx.put("ai_live", str(model, "id"), entry)
	})
}
func putAIDay(tx *transaction, id string, day Object) error {
	stat := aiDayStat(day)
	stat["id"], stat["modelId"] = id+":"+str(day, "date"), id
	return tx.put("ai_day", str(stat, "id"), stat)
}
func (a *App) archiveAIHistory(ctx context.Context, now int64, retention int) error {
	return a.store.mutate(ctx, func(tx *transaction) error {
		live, err := tx.list("ai_live")
		if err != nil {
			return err
		}
		today := time.Unix(now, 0).UTC().Format("2006-01-02")
		for _, entry := range live {
			day := object(entry["day"])
			if day != nil && str(day, "date") < today {
				if err = putAIDay(tx, str(entry, "modelId"), day); err != nil {
					return err
				}
			}
		}
		days, err := tx.list("ai_day")
		if err != nil {
			return err
		}
		floor := time.Unix(now-int64(retention)*86400, 0).UTC().Format("2006-01-02")
		for _, day := range days {
			if str(day, "date") < floor {
				if err = tx.remove("ai_day", str(day, "id")); err != nil {
					return err
				}
			}
		}
		return nil
	})
}
func (a *App) aiNotificationCurrent(ctx context.Context, event Object, channelID string) (bool, error) {
	id := str(event, "aiModelId")
	if id == "" {
		return true, nil
	}
	if enabled, err := a.aiEnabled(ctx); err != nil || !enabled {
		return false, err
	}
	model, err := a.store.get(ctx, "ai_model", id)
	if err != nil {
		return false, err
	}
	if model == nil || !boolean(model["enabled"]) || model["checkRevision"] != event["aiRevision"] {
		return false, nil
	}
	channel, err := a.store.get(ctx, "ai_channel", str(model, "channelId"))
	if err != nil {
		return false, err
	}
	if channel == nil || channel["checkRevision"] != event["aiChannelRevision"] {
		return false, nil
	}
	notification, err := a.store.get(ctx, "notification", channelID)
	event["notificationEnabled"], event["notificationChannelIds"], event["aiChannelId"] = channel["notificationEnabled"] != false, channel["notificationChannelIds"], channel["id"]
	return err == nil && notification != nil && notificationRoutingReason(notification, event) == "", err
}
