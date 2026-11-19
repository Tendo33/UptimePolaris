package polaris

import (
	"net/url"
	"sort"
	"strings"
)

func redactSubscriptionIssues(issues []any, secrets Object) {
	for _, raw := range issues {
		issue := object(raw)
		for _, value := range secrets {
			secret, ok := value.(string)
			if ok && secret != "" && (strings.Contains(str(issue, "itemId"), secret) || strings.Contains(str(issue, "itemId"), url.PathEscape(secret)) || strings.Contains(str(issue, "itemId"), url.QueryEscape(secret))) {
				issue["itemId"] = "[redacted]"
			}
		}
	}
}

func redactSubscriptionItems(items []any, secrets Object) error {
	values := []string{}
	for _, raw := range secrets {
		value, ok := raw.(string)
		if ok && value != "" {
			values = append(values, value, url.QueryEscape(value), url.PathEscape(value))
		}
	}
	sort.Slice(values, func(i, j int) bool { return len(values[i]) > len(values[j]) })
	clean := func(raw any) any {
		if raw == nil {
			return nil
		}
		text, ok := raw.(string)
		if !ok {
			return raw
		}
		for _, secret := range values {
			text = strings.ReplaceAll(text, secret, "[redacted]")
		}
		return text
	}
	for _, raw := range items {
		item := object(raw)
		for _, secret := range values {
			if strings.Contains(str(item, "sourceItemId"), secret) {
				return subscriptionError("sensitive_identity")
			}
		}
		for _, field := range []string{"name", "group", "modelId", "provider", "protocol"} {
			item[field] = clean(item[field])
		}
		if address := str(item, "url"); address != "" {
			parsed, err := url.Parse(address)
			if err != nil {
				item["url"] = nil
			} else {
				parsed.User = nil
				parsed.RawQuery = ""
				parsed.Fragment = ""
				item["url"] = clean(parsed.String())
			}
		}
		if observation := object(item["observation"]); observation != nil {
			observation["reason"] = clean(observation["reason"])
		}
		for _, raw := range array(item["recent"]) {
			point := object(raw)
			point["reason"] = clean(point["reason"])
		}
	}
	return nil
}
