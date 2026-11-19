package polaris

import (
	"fmt"
	"math"
	"net/url"
	"sort"
	"strings"
)

func subText(value any, limit int) any {
	if value == nil {
		return nil
	}
	switch value.(type) {
	case string, float64, int, int64:
	default:
		return nil
	}
	runes := []rune(strings.TrimSpace(fmt.Sprint(value)))
	clean := make([]rune, 0, len(runes))
	for _, character := range runes {
		if character >= 32 && character != 127 {
			clean = append(clean, character)
		}
	}
	if len(clean) > limit {
		clean = clean[:limit]
	}
	if len(clean) == 0 {
		return nil
	}
	return string(clean)
}

func subRows(value any) []any {
	if values, ok := value.([]any); ok {
		return values
	}
	if value == nil {
		return []any{}
	}
	return []any{value}
}

func parseSubscriptionResponses(descriptor, responses Object, fetchedAt int64, caches ...Object) (Object, error) {
	if len(caches) > 0 {
		if stamp := integer(object(caches[0][str(object(descriptor["observations"]), "request")]), "fetchedAt"); stamp > 0 {
			fetchedAt = stamp
		}
	}
	itemsSpec, observationSpec := object(descriptor["items"]), object(descriptor["observations"])
	catalog := responses[str(itemsSpec, "request")]
	if catalog == nil {
		return nil, failure("subscription_catalog_unavailable", 502)
	}
	matches, err := subPath(catalog, str(itemsSpec, "path"), true)
	if err != nil {
		return nil, err
	}
	if len(matches) == 1 {
		if values, ok := matches[0].value.([]any); ok {
			parent := matches[0].parent
			matches = []subMatch{}
			for _, value := range values {
				matches = append(matches, subMatch{value, parent, catalog})
			}
		}
	}
	if len(matches) > 1000 {
		return nil, subscriptionError("limit_exceeded")
	}
	response := responses[str(observationSpec, "request")]
	remote := response
	if path := str(observationSpec, "path"); path != "" {
		remote = subValue(response, path)
	}
	join := object(observationSpec["join"])
	joined := map[string][]any{}
	if join != nil {
		for _, row := range subRows(remote) {
			if key := subText(subValue(row, str(join, "path")), 256); key != nil {
				joined[fmt.Sprint(key)] = append(joined[fmt.Sprint(key)], row)
			}
		}
	}
	items, issues := []Object{}, []Object{}
	counts := map[string]int{}
	complete := true
	issue := func(code, path, id string) {
		if len(issues) < 100 {
			issues = append(issues, Object{"code": "subscription_" + code, "path": path, "itemId": id})
		}
	}
	for _, match := range matches {
		if !subFilter(match.value, object(itemsSpec["filter"])) {
			continue
		}
		fields := object(itemsSpec["fields"])
		field := func(key string) any { return subField(fields[key], match) }
		rawID := field("id")
		id := ""
		if value, ok := rawID.(string); ok {
			id = value
		} else if value, ok := rawID.(float64); ok && math.Trunc(value) == value && math.Abs(value) <= 9007199254740991 {
			id = fmt.Sprint(value)
		}
		if id == "" || len(id) > 256 || strings.TrimSpace(id) != id || strings.IndexFunc(id, func(c rune) bool { return c < 32 || c == 127 }) >= 0 {
			issue("item_id_invalid", str(itemsSpec, "path"), id)
			complete = false
			continue
		}
		name := subText(field("name"), 160)
		if name == nil {
			issue("item_name_invalid", str(itemsSpec, "path"), id)
			complete = false
			continue
		}
		counts[id]++
		values := []any{}
		if observationSpec["lookupBy"] != nil {
			values = subRows(object(remote)[id])
		} else if join != nil {
			key := id
			if join["itemPath"] != nil {
				key = fmt.Sprint(subValue(match.value, str(join, "itemPath")))
			}
			values = joined[key]
			if len(values) > 1 && observationSpec["mode"] == "snapshot" {
				issue("join_ambiguous", str(itemsSpec, "path"), id)
				continue
			}
		} else if observationSpec["request"] == itemsSpec["request"] && observationSpec["path"] == nil {
			values = []any{match.value}
		} else {
			values = subRows(remote)
		}
		if len(values) > 10000 {
			return nil, subscriptionError("limit_exceeded")
		}
		if len(values) == 0 {
			issue("observation_missing", str(observationSpec, "path"), id)
		}
		points := []Object{}
		for _, value := range values {
			observedAt, changedAt := any(nil), any(nil)
			if spec := object(observationSpec["observedAt"]); spec != nil {
				observedAt = subTime(subValue(value, str(spec, "path")), spec, fetchedAt)
			}
			if observationSpec["mode"] == "heartbeat" && observedAt == nil {
				issue("time_invalid", str(object(observationSpec["observedAt"]), "path"), id)
				continue
			}
			if spec := object(observationSpec["changedAt"]); spec != nil {
				changedAt = subTime(subValue(value, str(spec, "path")), spec, fetchedAt)
			}
			statusSpec := object(observationSpec["status"])
			raw := subValue(value, str(statusSpec, "path"))
			key := fmt.Sprint(raw)
			status := str(object(statusSpec["map"]), key)
			if status == "" {
				status = "unknown"
				issue("status_unknown", str(statusSpec, "path"), id)
			}
			var latency any
			if spec := object(observationSpec["latency"]); spec != nil {
				raw := subValue(value, str(spec, "path"))
				if n, ok := raw.(float64); ok && n >= 0 && !math.IsNaN(n) && !math.IsInf(n, 0) {
					if spec["unit"] == "s" {
						n *= 1000
					}
					latency = n
				}
			}
			var reason any
			if observationSpec["reason"] != nil {
				reason = subText(subValue(value, str(observationSpec, "reason")), 500)
			}
			points = append(points, Object{"status": status, "observedAt": observedAt, "changedAt": changedAt, "fetchedAt": fetchedAt, "latencyMs": latency, "reason": reason})
		}
		if observationSpec["mode"] == "heartbeat" {
			sort.SliceStable(points, func(i, j int) bool { return number(points[i]["observedAt"]) < number(points[j]["observedAt"]) })
		}
		dedup := []Object{}
		positions := map[float64]int{}
		for _, point := range points {
			timestamp := number(point["observedAt"])
			if point["observedAt"] == nil {
				timestamp = float64(fetchedAt)
			}
			if index, ok := positions[timestamp]; ok {
				dedup[index] = point
			} else {
				positions[timestamp] = len(dedup)
				dedup = append(dedup, point)
			}
		}
		if len(dedup) > 60 {
			dedup = dedup[len(dedup)-60:]
		}
		var observation any
		if len(dedup) > 0 {
			observation = dedup[len(dedup)-1]
		}
		var availability any
		if metric := object(object(descriptor["metrics"])["availability"]); metric != nil {
			raw := subValue(responses[str(metric, "request")], str(metric, "path"))
			if metric["lookupBy"] != nil {
				raw = object(raw)[id+str(metric, "suffix")]
			}
			if n, ok := raw.(float64); ok {
				if metric["unit"] == "ratio" {
					n *= 100
				}
				if n >= 0 && n <= 100 {
					availability = Object{"value": n, "windowSec": metric["windowSec"], "fetchedAt": fetchedAt, "origin": "source"}
				}
			}
		}
		link := subText(field("url"), 2048)
		if link != nil {
			parsed, err := url.Parse(fmt.Sprint(link))
			if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil {
				link = nil
			}
		}
		items = append(items, Object{"sourceItemId": id, "name": name, "group": subText(field("group"), 160), "url": link, "modelId": subText(field("modelId"), 256), "provider": subText(field("provider"), 160), "protocol": subText(field("protocol"), 160), "mode": observationSpec["mode"], "observation": observation, "recent": dedup, "availability": availability, "sourceCurrent": observationSpec["currentWhen"] == nil || subFilter(match.value, object(observationSpec["currentWhen"]))})
	}
	filtered := []Object{}
	for _, item := range items {
		id := str(item, "sourceItemId")
		if counts[id] > 1 {
			if counts[id] > 0 {
				issue("item_duplicate", str(itemsSpec, "path"), id)
				counts[id] = -1
			}
			complete = false
			continue
		}
		if counts[id] < 0 {
			continue
		}
		filtered = append(filtered, item)
	}
	return Object{"items": filtered, "issues": issues, "complete": complete}, nil
}
