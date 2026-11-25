// Empty groups are omitted and populated ungrouped monitors remain last.
// 省略空分组，有监控的未分组项保留在末尾。
package polaris

import "testing"

func TestPublicMonitorGroups(t *testing.T) {
	s := newTestServer(t)
	readGroups := func() []any {
		t.Helper()
		code, result := s.request(t, "GET", "/api/public/monitors", nil, false)
		expectStatus(t, code, 200, result)
		groups, ok := result["monitorGroups"].([]any)
		if !ok {
			t.Fatal("monitorGroups must be an array", result)
		}
		return groups
	}
	if groups := readGroups(); len(groups) != 0 {
		t.Fatal("zero monitors must yield no groups", groups)
	}
	code, later := s.request(t, "POST", "/api/groups", Object{"name": "Later", "weight": 50}, true)
	expectStatus(t, code, 201, later)
	code, first := s.request(t, "POST", "/api/groups", Object{"name": "First", "weight": 1}, true)
	expectStatus(t, code, 201, first)
	code, private := s.request(t, "POST", "/api/monitors", Object{"name": "Private", "type": "http", "target": "https://example.com", "is_public": false}, true)
	expectStatus(t, code, 201, private)
	if groups := readGroups(); len(groups) != 0 {
		t.Fatal("empty named groups and private monitors must yield no public groups", groups)
	}
	for _, group := range []Object{later, first} {
		code, result := s.request(t, "POST", "/api/monitors", Object{"name": "in-" + str(group, "id"), "type": "http", "target": "https://example.com", "group_id": group["id"]}, true)
		expectStatus(t, code, 201, result)
	}
	groups := readGroups()
	if len(groups) != 2 || str(object(groups[0]), "name") != "First" || str(object(groups[1]), "name") != "Later" {
		t.Fatal("all grouped monitors must yield only named groups in weight order", groups)
	}
	for _, value := range groups {
		group := object(value)
		if boolean(group["isUngrouped"]) || len(array(group["monitorList"])) != 1 {
			t.Fatal("named group must contain its monitor and have no ungrouped flag", group)
		}
	}
	id := s.createMonitor(t, "http", "https://example.com", nil)
	groups = readGroups()
	if len(groups) != 3 || str(object(groups[0]), "name") != "First" || str(object(groups[1]), "name") != "Later" {
		t.Fatal("mixed monitors must retain named groups before the ungrouped bucket", groups)
	}
	ungrouped := object(groups[2])
	list := array(ungrouped["monitorList"])
	if ungrouped["isUngrouped"] != true || ungrouped["name"] != nil || integer(ungrouped, "id") != 0 || len(list) != 1 {
		t.Fatal("ungrouped bucket must be last with a null label and one public monitor", ungrouped)
	}
	if str(object(list[0]), "name") != "http fixture" {
		t.Fatal("ungrouped monitor missing", list)
	}
	code, result := s.request(t, "DELETE", "/api/monitors/"+id, nil, true)
	expectStatus(t, code, 200, result)
	if groups := readGroups(); len(groups) != 2 {
		t.Fatal("removing the last ungrouped monitor must remove its bucket", groups)
	}
}
