package polaris

import (
	"context"
	"fmt"
	"math/rand/v2"
	"sort"
	"strings"
	"sync"
	"time"
)

func subscriptionInitialRuntime() Object {
	return Object{"runId": nil, "phase": "idle", "health": "healthy", "lastAttemptAt": nil, "lastSuccessAt": nil, "nextDueAt": 0, "failureSince": nil, "failures": 0, "announcedFailure": false, "error": nil, "itemCount": 0, "selectedCount": 0}
}
func subscriptionDefaultNotifications() Object {
	return Object{"monitor": Object{"notificationEnabled": false, "notificationChannelIds": []string{}}, "sync": Object{"notificationEnabled": false, "notificationChannelIds": []string{}, "afterSec": 300}}
}
func newSubscriptionItem(source, subscription Object, selected bool) Object {
	item := clone(source)
	for key, value := range (Object{"id": uuid(), "subscriptionId": subscription["id"], "category": subscription["category"], "revision": uuid(), "selected": selected, "isPublic": false, "muted": false, "localName": nil, "groupId": nil, "sortOrder": 0, "removedAt": nil, "syncRevision": subscription["syncRevision"], "baseline": false, "announced": nil, "observationWatermark": nil, "days": []any{}, "freshness": "never_received", "displayStatus": "unknown", "recent": []any{}, "observation": nil}) {
		item[key] = value
	}
	return item
}

func subscriptionItemView(item, subscription Object, now int64) Object {
	view := clone(item)
	observation := object(view["observation"])
	freshness := "current"
	stamp := integer(observation, "fetchedAt")
	if view["mode"] == "heartbeat" {
		stamp = integer(observation, "observedAt")
	}
	if view["removedAt"] != nil {
		freshness = "removed"
	} else if !boolean(subscription["enabled"]) || subscription["archivedAt"] != nil {
		freshness = "paused"
	} else if view["syncRevision"] != subscription["syncRevision"] {
		freshness = "configuration_changed"
	} else if view["sourceCurrent"] == false {
		freshness = "stale"
	} else if observation == nil {
		freshness = "never_received"
	} else if now > stamp+integer(subscription, "staleAfterSec") || now > integer(observation, "fetchedAt")+max(integer(subscription, "staleAfterSec"), integer(subscription, "intervalSec")*3) {
		freshness = "stale"
	}
	view["freshness"], view["displayStatus"] = freshness, "unknown"
	if freshness == "current" {
		view["displayStatus"] = observation["status"]
	}
	return view
}

func mergeSubscriptionItem(previous, source Object, version string, now int64) Object {
	item := clone(previous)
	changed := previous["syncRevision"] != version || previous["removedAt"] != nil
	for _, field := range []string{"name", "group", "url", "modelId", "provider", "protocol", "mode", "availability", "sourceCurrent"} {
		item[field] = source[field]
	}
	recent := array(item["recent"])
	days := map[string]Object{}
	for _, raw := range array(item["days"]) {
		day := clone(object(raw))
		days[str(day, "date")] = day
	}
	watermark := number(item["observationWatermark"])
	latest := object(item["observation"])
	if changed {
		latest = nil
		item["baseline"], item["announced"] = false, nil
	}
	if boolean(item["selected"]) && source["sourceCurrent"] != false {
		points := array(source["recent"])
		if source["mode"] == "snapshot" {
			points = subRows(source["observation"])
		}
		for _, raw := range points {
			point := object(raw)
			if source["mode"] == "snapshot" {
				if latest == nil || latest["status"] != point["status"] {
					recent = append(recent, point)
				}
				latest = point
				continue
			}
			timestamp := number(point["observedAt"])
			index := -1
			for i, old := range recent {
				if number(object(old)["observedAt"]) == timestamp {
					index = i
					break
				}
			}
			if index < 0 && timestamp <= watermark {
				continue
			}
			date := time.Unix(int64(timestamp), 0).UTC().Format("2006-01-02")
			day := days[date]
			if day == nil {
				day = Object{"date": date, "total": 0, "up": 0, "origin": "received_observations"}
				days[date] = day
			}
			if index >= 0 {
				if object(recent[index])["status"] == "up" {
					day["up"] = integer(day, "up") - 1
				}
				recent[index] = point
			} else {
				day["total"] = integer(day, "total") + 1
				recent = append(recent, point)
			}
			if point["status"] == "up" {
				day["up"] = integer(day, "up") + 1
			}
			day["availabilityPct"] = aiPercent(integer(day, "up"), integer(day, "total"))
			if latest == nil || timestamp >= number(latest["observedAt"]) {
				latest = point
			}
			if timestamp > watermark {
				watermark = timestamp
			}
		}
	}
	if len(recent) > 60 {
		recent = recent[len(recent)-60:]
	}
	cutoff := time.Unix(now-89*86400, 0).UTC().Format("2006-01-02")
	history := []Object{}
	for _, key := range subKeys(daysAsObject(days)) {
		if key >= cutoff {
			history = append(history, days[key])
		}
	}
	item["recent"], item["days"], item["observation"], item["observationWatermark"], item["syncRevision"], item["removedAt"] = recent, history, latest, watermark, version, nil
	return item
}
func daysAsObject(days map[string]Object) Object {
	result := Object{}
	for key, value := range days {
		result[key] = value
	}
	return result
}

func (a *App) subscriptionItems(ctx context.Context, id string) ([]Object, error) {
	rows, err := a.store.subscriptionDocuments(ctx, a.store.db, "subscription_item", id)
	if err != nil {
		return nil, err
	}
	result := []Object{}
	for _, row := range rows {
		if str(row, "subscriptionId") == id {
			result = append(result, row)
		}
	}
	sort.Slice(result, func(i, j int) bool { return str(result[i], "sourceItemId") < str(result[j], "sourceItemId") })
	return result, nil
}

func subStatusNumber(status string) int {
	if status == "up" {
		return 1
	}
	if status == "down" {
		return 0
	}
	return 2
}
func subscriptionEvent(subscription, item Object, policy Object, from, to, eventKind string, at int64) Object {
	id, name := "subscription-sync:"+str(subscription, "id"), str(subscription, "name")
	target, group := "", ""
	itemID := ""
	if item != nil {
		itemID = str(item, "id")
		id = "subscription:" + itemID
		name = str(item, "localName")
		if name == "" {
			name = str(item, "name")
		}
		target = str(item, "url")
		if subscription["category"] == "website" {
			group = str(item, "groupId")
		}
	}
	return Object{"monitorId": id, "monitorName": name, "monitorTarget": target, "monitorType": "subscription_" + str(subscription, "category"), "eventKind": eventKind, "sourceType": "subscription", "subscriptionId": subscription["id"], "subscriptionItemId": itemID, "syncRevision": subscription["syncRevision"], "notificationEnabled": policy["notificationEnabled"], "notificationChannelIds": policy["notificationChannelIds"], "groupId": group, "status": subStatusNumber(to), "prevStatus": subStatusNumber(from), "at": at, "message": str(object(item["observation"]), "reason"), "eventKey": fmt.Sprintf("%v:%s:%d:%s", subscription["syncRevision"], id, at, to)}
}

func (a *App) queueSubscriptionEvent(tx *transaction, event Object) error {
	channels, err := tx.list("notification")
	if err != nil {
		return err
	}
	for _, channel := range channels {
		if notificationRoutingReason(channel, event) != "" {
			continue
		}
		id := str(event, "eventKey") + ":" + str(channel, "id")
		previous, err := tx.get("outbox", id)
		if err != nil {
			return err
		}
		if previous != nil {
			continue
		}
		sequence, err := tx.next("outbox")
		if err != nil {
			return err
		}
		now := time.Now().Unix()
		if err := tx.put("outbox", id, Object{"id": id, "channel_id": channel["id"], "event": event, "sequence": sequence, "created_at": now, "attempts": 0, "next_at": now, "state": "pending"}); err != nil {
			return err
		}
	}
	return nil
}

func (a *App) runSubscription(ctx context.Context, id string, force bool, background ...bool) (Object, error) {
	subscription, err := a.store.get(ctx, "subscription", id)
	if err != nil {
		return nil, err
	}
	if subscription == nil {
		return nil, failure("not_found", 404)
	}
	if !boolean(subscription["enabled"]) || subscription["archivedAt"] != nil {
		return nil, failure("subscription_paused", 409)
	}
	if subscription["category"] == "model" {
		enabled, err := a.aiEnabled(ctx)
		if err != nil {
			return nil, err
		}
		if !enabled {
			return nil, failure("ai_disabled", 409)
		}
	}
	token, now := uuid(), time.Now().Unix()
	claimed, err := a.store.claim(ctx, "subscription:"+id, token, now, 90, force)
	if err != nil {
		return nil, err
	}
	if !claimed {
		if force {
			var owner string
			if err := a.store.db.QueryRowContext(ctx, a.store.query("SELECT owner FROM polaris_leases WHERE id=?"), "subscription:"+id).Scan(&owner); err == nil {
				if run, err := a.store.get(ctx, "subscription_run", owner); err == nil && run != nil {
					return run, nil
				}
			}
		}
		return nil, failure("subscription_busy", 409)
	}
	run := Object{"id": token, "subscriptionId": id, "state": "running", "phase": "fetching", "startedAt": now, "finishedAt": nil, "updatedItems": 0, "requests": 0, "error": nil, "expiresAt": now + 7*86400}
	if err := a.store.put(ctx, "subscription_run", token, run); err != nil {
		return nil, err
	}
	if len(background) > 0 && background[0] {
		initial := clone(run)
		a.wg.Add(1)
		go func() {
			defer a.wg.Done()
			a.storeLock.RLock()
			defer a.storeLock.RUnlock()
			_, _ = a.executeSubscription(a.ctx, subscription, run, force)
		}()
		return initial, nil
	}
	return a.executeSubscription(ctx, subscription, run, force)
}

func (a *App) executeSubscription(ctx context.Context, subscription, run Object, force bool) (result Object, runErr error) {
	id, token, now := str(subscription, "id"), str(run, "id"), integer(run, "startedAt")
	nextDue := now + integer(subscription, "intervalSec")
	deadline := time.Now().Add(25 * time.Second)
	defer func() {
		if runErr != nil && run["finishedAt"] == nil {
			code := "subscription_storage_unavailable"
			if strings.HasPrefix(runErr.Error(), "subscription_") {
				code = runErr.Error()
			}
			run["state"], run["error"], run["finishedAt"], run["phase"] = "failed", code, time.Now().Unix(), "complete"
			if integer(run, "updatedItems") > 0 {
				run["state"] = "partial"
			}
			_ = a.store.put(context.Background(), "subscription_run", token, run)
			nextDue = time.Now().Unix() + 3600
			_ = a.store.mutate(context.Background(), func(tx *transaction) error {
				current, err := tx.get("subscription", id)
				if err != nil || current == nil {
					return err
				}
				if current["syncRevision"] != subscription["syncRevision"] || !boolean(current["enabled"]) {
					return nil
				}
				var owner string
				if err := tx.tx.QueryRowContext(context.Background(), tx.store.query("SELECT owner FROM polaris_leases WHERE id=?"), "subscription:"+id).Scan(&owner); err != nil || owner != token {
					return err
				}
				runtime := clone(object(current["runtime"]))
				runtime["health"], runtime["error"], runtime["lastAttemptAt"], runtime["nextDueAt"] = run["state"], code, now, nextDue
				runtime["failures"] = integer(runtime, "failures") + 1
				if runtime["failureSince"] == nil {
					runtime["failureSince"] = now
				}
				settings, err := tx.get("config", "settings")
				if err != nil {
					return err
				}
				policy := object(object(current["notifications"])["sync"])
				if boolean(policy["notificationEnabled"]) && !boolean(maintenance(settings)["active"]) && !boolean(runtime["announcedFailure"]) && now-integer(runtime, "failureSince") >= integer(policy, "afterSec") {
					event := subscriptionEvent(current, nil, policy, "up", "down", "subscription_sync", now)
					event["message"], event["subscriptionLastSuccessAt"], event["subscriptionAffectedItems"] = code, runtime["lastSuccessAt"], runtime["selectedCount"]
					if err := a.queueSubscriptionEvent(tx, event); err != nil {
						return err
					}
					runtime["announcedFailure"] = true
				}
				current["runtime"] = runtime
				return tx.put("subscription", id, current)
			})
		}
		_ = a.store.release(context.Background(), "subscription:"+id, token, nextDue)
	}()
	config, err := a.store.get(ctx, "subscription_config", str(subscription, "configId"))
	if err != nil || config == nil {
		return nil, failure("subscription_config_unavailable", 503)
	}
	parameters := clone(object(config["parameters"]))
	secrets, err := a.decryptSubscription(ctx, config)
	if err != nil {
		return nil, err
	}
	for key, value := range secrets {
		parameters[key] = value
	}
	checkpoint, err := a.store.get(ctx, "subscription_checkpoint", id)
	if err != nil {
		return nil, err
	}
	var payload Object
	if checkpoint != nil && checkpoint["syncRevision"] == subscription["syncRevision"] && integer(checkpoint, "expiresAt") > now {
		payload, err = a.store.get(ctx, "subscription_normalized", str(checkpoint, "payloadId"))
		if err != nil {
			return nil, err
		}
	}
	var fetched, parsed, cacheDocument Object
	var fetchErr error
	if payload == nil {
		cache, err := a.subscriptionResponseCache(ctx, subscription)
		if err != nil {
			return nil, err
		}
		fetched, fetchErr = a.fetchSubscription(ctx, object(config["descriptor"]), parameters, cache, force)
		if fetchErr == nil {
			run["requests"] = fetched["requests"]
			run["phase"] = "parsing"
			if err := a.store.put(ctx, "subscription_run", token, run); err != nil {
				return nil, err
			}
			parsed, fetchErr = parseSubscriptionResponses(object(config["descriptor"]), object(fetched["responses"]), now, object(fetched["cache"]))
			parsed, fetched = clone(parsed), clone(fetched)
			if fetchErr == nil {
				fetchErr = redactSubscriptionItems(array(parsed["items"]), secrets)
				redactSubscriptionIssues(array(parsed["issues"]), secrets)
			}
		}
		if fetchErr != nil {
			parsed = nil
			run["state"], run["error"] = "failed", fetchErr.Error()
			if issues := array(clone(fetched)["failures"]); len(issues) > 0 {
				run["error"] = object(issues[0])["code"]
			}
		} else {
			run["state"] = "ready"
			if len(array(fetched["failures"])) > 0 || len(array(parsed["issues"])) > 0 {
				run["state"] = "partial"
				if issues := append(array(fetched["failures"]), array(parsed["issues"])...); len(issues) > 0 {
					run["error"] = object(issues[0])["code"]
				}
			}
		}
		if parsed != nil {
			cacheDocument, err = a.subscriptionCacheDocument(ctx, subscription, object(fetched["cache"]))
			if err != nil {
				return nil, err
			}
		}

		if parsed != nil {
			payload = Object{"parsed": parsed, "failures": fetched["failures"], "requests": fetched["requests"], "cacheDocument": cacheDocument, "subscriptionId": id, "expiresAt": now + 3600}
			checkpoint = Object{"payloadId": token, "offset": 0, "syncRevision": subscription["syncRevision"], "subscriptionId": id, "expiresAt": now + 3600}
			if err := a.store.put(ctx, "subscription_normalized", token, payload); err != nil {
				return nil, err
			}
			if err := a.store.put(ctx, "subscription_checkpoint", id, checkpoint); err != nil {
				return nil, err
			}
		} else {
			checkpoint = nil
		}
	} else {
		parsed, cacheDocument = object(payload["parsed"]), object(payload["cacheDocument"])
		fetched = Object{"failures": payload["failures"], "requests": payload["requests"]}
		run["requests"], run["updatedItems"], run["state"] = payload["requests"], checkpoint["offset"], "ready"
		if issues := append(array(fetched["failures"]), array(parsed["issues"])...); len(issues) > 0 {
			run["state"], run["error"] = "partial", object(issues[0])["code"]
		}
	}
	run["phase"] = "committing"
	progress := clone(run)
	progress["state"] = "running"
	if err := a.store.put(ctx, "subscription_run", token, progress); err != nil {
		return nil, err
	}
	allSources := array(parsed["items"])
	seen := map[string]bool{}
	for _, raw := range allSources {
		seen[str(object(raw), "sourceItemId")] = true
	}
	for offset := int(integer(checkpoint, "offset")); ; offset += 25 {
		lastBatch := offset+25 >= len(allSources)
		batch := allSources[min(offset, len(allSources)):min(offset+25, len(allSources))]
		err = a.store.mutate(ctx, func(tx *transaction) error {
			current, err := tx.get("subscription", id)
			if err != nil {
				return err
			}
			if current == nil || !boolean(current["enabled"]) || current["archivedAt"] != nil || current["syncRevision"] != subscription["syncRevision"] {
				return failure("subscription_run_obsolete", 409)
			}
			var owner string
			var expires int64
			if err := tx.tx.QueryRowContext(ctx, tx.store.query("SELECT owner,expires_at FROM polaris_leases WHERE id=?"), "subscription:"+id).Scan(&owner, &expires); err != nil || owner != token || expires <= time.Now().Unix() {
				return failure("subscription_run_obsolete", 409)
			}
			settings, err := tx.get("config", "settings")
			if err != nil {
				return err
			}
			suppressed := boolean(maintenance(settings)["active"])
			var sourceFilter [][]string
			if !lastBatch {
				ids := []string{}
				for _, raw := range batch {
					ids = append(ids, str(object(raw), "sourceItemId"))
				}
				sourceFilter = append(sourceFilter, ids)
			}
			all, err := tx.store.subscriptionDocuments(ctx, tx.tx, "subscription_item", id, sourceFilter...)
			if err != nil {
				return err
			}
			bySource := map[string]Object{}
			for _, item := range all {
				if item["subscriptionId"] == id && !boolean(item["identityArchived"]) {
					bySource[str(item, "sourceItemId")] = item
				}
			}
			if parsed != nil {
				for _, raw := range batch {
					source := object(raw)
					sourceID := str(source, "sourceItemId")
					seen[sourceID] = true
					old := bySource[sourceID]
					if old == nil {
						old = newSubscriptionItem(source, current, boolean(current["autoSubscribe"]))
					}
					item := subscriptionItemView(mergeSubscriptionItem(old, source, str(current, "syncRevision"), now), current, now)
					observation := object(item["observation"])
					state := str(observation, "status")
					policy := object(object(current["notifications"])["monitor"])
					if item["freshness"] == "current" && contains([]string{"up", "down", "degraded"}, state) {
						if boolean(item["selected"]) && !boolean(item["muted"]) && boolean(policy["notificationEnabled"]) && !suppressed && boolean(item["baseline"]) && contains([]string{"up", "down", "degraded"}, str(item, "announced")) && item["announced"] != state {
							kind := "monitor_state"
							if current["category"] == "model" {
								kind = "ai_state"
							}
							at := integer(observation, "observedAt")
							if at == 0 {
								at = now
							}
							if err := a.queueSubscriptionEvent(tx, subscriptionEvent(current, item, policy, str(item, "announced"), state, kind, at)); err != nil {
								return err
							}
						}
						item["baseline"], item["announced"] = true, state
					}
					if err := tx.put("subscription_item", str(item, "id"), item); err != nil {
						return err
					}
					bySource[sourceID] = item
					run["updatedItems"] = integer(run, "updatedItems") + 1
				}
				if lastBatch && boolean(parsed["complete"]) {
					for sourceID, item := range bySource {
						if !seen[sourceID] && item["removedAt"] == nil {
							item["removedAt"], item["baseline"] = now, false
							if err := tx.put("subscription_item", str(item, "id"), item); err != nil {
								return err
							}
						}
					}
				}
				if lastBatch {
					if err := tx.put("subscription_cache", id, cacheDocument); err != nil {
						return err
					}
				}
			}
			if !lastBatch {
				checkpoint["offset"] = offset + 25
				if err := tx.put("subscription_checkpoint", id, checkpoint); err != nil {
					return err
				}
				if _, err := tx.tx.ExecContext(ctx, tx.store.query("UPDATE polaris_leases SET expires_at=? WHERE id=? AND owner=?"), time.Now().Unix()+90, "subscription:"+id, token); err != nil {
					return err
				}
				progress := clone(run)
				progress["state"] = "running"
				return tx.put("subscription_run", token, progress)
			}
			if checkpoint != nil {
				if err := tx.remove("subscription_checkpoint", id); err != nil {
					return err
				}
				if err := tx.remove("subscription_normalized", str(checkpoint, "payloadId")); err != nil {
					return err
				}
			}
			runtime := clone(object(current["runtime"]))
			healthy := run["state"] == "ready"
			runtime["lastAttemptAt"], runtime["error"] = now, run["error"]
			if healthy {
				runtime["health"], runtime["failures"], runtime["failureSince"], runtime["lastSuccessAt"] = "healthy", 0, nil, now
			} else {
				runtime["health"] = run["state"]
				runtime["failures"] = integer(runtime, "failures") + 1
				if runtime["failureSince"] == nil {
					runtime["failureSince"] = now
				}
				delay := integer(current, "intervalSec") << min(integer(runtime, "failures"), 5)
				backoff := min(delay, 3600)
				nextDue = now + backoff + rand.Int64N(max(1, min(30, backoff/10)))
				code := str(run, "error")
				if strings.Contains(code, "authentication") || strings.Contains(code, "descriptor") || strings.Contains(code, "mapping") || strings.Contains(code, "response_invalid") || strings.Contains(code, "parameters_invalid") {
					nextDue = now + 3600
				}
				for _, raw := range array(fetched["failures"]) {
					nextDue = max(nextDue, now+integer(object(raw), "retryAfterSec"))
				}
			}
			runtime["nextDueAt"], runtime["itemCount"], runtime["selectedCount"], runtime["phase"], runtime["runId"] = nextDue, 0, 0, "idle", nil
			for _, item := range bySource {
				if item["removedAt"] == nil {
					runtime["itemCount"] = integer(runtime, "itemCount") + 1
					if boolean(item["selected"]) {
						runtime["selectedCount"] = integer(runtime, "selectedCount") + 1
					}
				}
			}
			policy := object(object(current["notifications"])["sync"])
			transition := ""
			if healthy && boolean(runtime["announcedFailure"]) {
				transition = "up"
			} else if !healthy && now-integer(runtime, "failureSince") >= integer(policy, "afterSec") && !boolean(runtime["announcedFailure"]) {
				transition = "down"
			}
			if transition != "" && boolean(policy["notificationEnabled"]) && !suppressed {
				from := "up"
				if transition == "up" {
					from = "down"
				}
				event := subscriptionEvent(current, nil, policy, from, transition, "subscription_sync", now)
				event["message"] = run["error"]
				event["subscriptionLastSuccessAt"], event["subscriptionAffectedItems"] = runtime["lastSuccessAt"], runtime["selectedCount"]
				if err := a.queueSubscriptionEvent(tx, event); err != nil {
					return err
				}
				runtime["announcedFailure"] = transition == "down"
			} else if !boolean(policy["notificationEnabled"]) {
				runtime["announcedFailure"] = false
			}
			current["runtime"] = runtime
			if err := tx.put("subscription", id, current); err != nil {
				return err
			}
			run["finishedAt"], run["phase"] = time.Now().Unix(), "complete"
			return tx.put("subscription_run", token, run)
		})
		if err != nil {
			run["updatedItems"] = offset
			if strings.Contains(err.Error(), "subscription_run_obsolete") {
				run["state"], run["finishedAt"] = "obsolete", time.Now().Unix()
				_ = a.store.put(ctx, "subscription_run", token, run)
			}
			return nil, err
		}
		if lastBatch {
			break
		}
		if time.Now().After(deadline) {
			nextDue = time.Now().Unix() + 60
			run["state"], run["phase"], run["error"], run["finishedAt"] = "deferred", "complete", "subscription_budget_deferred", time.Now().Unix()
			if err := a.store.put(ctx, "subscription_run", token, run); err != nil {
				return nil, err
			}
			break
		}
	}
	return run, nil
}

func (a *App) subscriptionCycle(ctx context.Context, wait bool) {
	if err := a.store.cleanupSubscriptions(ctx); err != nil {
		return
	}
	rows, err := a.store.list(ctx, "subscription")
	if err != nil {
		return
	}
	var group sync.WaitGroup
	for _, item := range rows {
		if !boolean(item["enabled"]) || item["archivedAt"] != nil || integer(object(item["runtime"]), "nextDueAt") > time.Now().Unix() {
			continue
		}
		select {
		case a.semaphore <- struct{}{}:
		default:
			continue
		}
		group.Add(1)
		a.wg.Add(1)
		go func(id string) {
			defer group.Done()
			defer a.wg.Done()
			defer func() { <-a.semaphore }()
			_, _ = a.runSubscription(ctx, id, false)
		}(str(item, "id"))
	}
	if wait {
		group.Wait()
	}
}
