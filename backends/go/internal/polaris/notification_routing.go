package polaris

import "strings"

func validNotificationIDs(raw any) bool {
	ids, ok := raw.([]any)
	if !ok || len(ids) > 32 {
		return false
	}
	seen := map[string]bool{}
	for _, value := range ids {
		id, ok := value.(string)
		if !ok || id == "" || len(id) > 64 || strings.TrimSpace(id) != id || seen[id] {
			return false
		}
		seen[id] = true
	}
	return true
}

func notificationMatches(channel Object, ids []string, groupID string) bool {
	if len(ids) > 0 {
		return contains(ids, str(channel, "id"))
	}
	scope := stringsOf(channel["group_ids"])
	return len(scope) == 0 || contains(scope, groupID)
}
