package polaris

import "context"

func subscriptionSourceHosts(config Object) []string {
	descriptor := object(config["descriptor"])
	hosts := Object{}
	for _, raw := range object(descriptor["requests"]) {
		request := object(raw)
		key := str(request, "baseUrlInput")
		value := object(config["parameters"])[key]
		if value == nil {
			value = object(object(descriptor["inputs"])[key])["default"]
		}
		if target, err := subscriptionURL(str(Object{"url": value}, "url")); err == nil {
			hosts[target.Hostname()] = true
		}
	}
	return subKeys(hosts)
}

func subscriptionIdentity(config Object) string {
	descriptor := object(config["descriptor"])
	items := object(descriptor["items"])
	request := object(object(descriptor["requests"])[str(items, "request")])
	used := Object{str(request, "baseUrlInput"): true}
	for _, match := range subscriptionInputToken.FindAllStringSubmatch(encode(request), -1) {
		used[match[1]] = true
	}
	parameters := []any{}
	for _, key := range subKeys(used) {
		input := object(object(descriptor["inputs"])[key])
		if input["type"] == "secret" {
			continue
		}
		value := object(config["parameters"])[key]
		if value == nil {
			value = input["default"]
		}
		parameters = append(parameters, []any{key, value})
	}
	return encode([]any{items["request"], items["path"], object(items["fields"])["id"], request["method"], request["path"], request["query"], request["body"], parameters})
}

func (a *App) subscriptionIdentityDiff(ctx context.Context, preview Object) (Object, error) {
	row, err := a.store.get(ctx, "subscription", str(preview, "subscriptionId"))
	if err != nil || row == nil {
		return nil, err
	}
	previous, err := a.store.get(ctx, "subscription_config", str(row, "configId"))
	if err != nil {
		return nil, err
	}
	items, err := a.subscriptionItems(ctx, str(row, "id"))
	if err != nil {
		return nil, err
	}
	oldIDs, newIDs := map[string]bool{}, map[string]bool{}
	old := []Object{}
	for _, item := range items {
		if item["removedAt"] == nil && !boolean(item["identityArchived"]) {
			oldIDs[str(item, "sourceItemId")] = true
			old = append(old, Object{"id": item["id"], "sourceItemId": item["sourceItemId"], "name": item["name"]})
		}
	}
	added, removed := []string{}, []string{}
	for _, raw := range array(preview["items"]) {
		id := str(object(raw), "sourceItemId")
		newIDs[id] = true
		if !oldIDs[id] {
			added = append(added, id)
		}
	}
	for _, item := range old {
		id := str(item, "sourceItemId")
		if !newIDs[id] {
			removed = append(removed, id)
		}
	}
	return Object{"changed": subscriptionIdentity(previous) != subscriptionIdentity(object(preview["config"])), "previous": old, "added": added, "removed": removed}, nil
}

func remapSubscriptionIdentities(items []Object, sources []any, mappings any, now int64) ([]Object, error) {
	values, ok := mappings.([]any)
	if !ok && mappings != nil || len(values) > 1000 {
		return nil, failure("subscription_identity_mapping_invalid", 400)
	}
	available, targets, old := map[string]bool{}, map[string]bool{}, map[string]bool{}
	for _, source := range sources {
		available[str(object(source), "sourceItemId")] = true
	}
	for _, item := range items {
		if !boolean(item["identityArchived"]) && item["removedAt"] == nil {
			old[str(item, "id")] = true
		}
	}
	mapping := map[string]string{}
	for _, raw := range values {
		entry := object(raw)
		id, target := str(entry, "itemId"), str(entry, "sourceItemId")
		if !old[id] || !available[target] || targets[target] || mapping[id] != "" {
			return nil, failure("subscription_identity_mapping_invalid", 400)
		}
		mapping[id] = target
		targets[target] = true
	}
	result := []Object{}
	for _, previous := range items {
		if boolean(previous["identityArchived"]) {
			continue
		}
		item := clone(previous)
		target := mapping[str(item, "id")]
		item["identityArchived"], item["removedAt"], item["baseline"], item["revision"] = true, now, false, uuid()
		if target != "" {
			item["identityArchived"], item["removedAt"], item["sourceItemId"] = false, nil, target
		}
		result = append(result, item)
	}
	return result, nil
}
