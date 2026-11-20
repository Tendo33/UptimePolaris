package polaris

import (
	"context"
	"crypto/rand"
	"database/sql"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func subscriptionFixture(t *testing.T, id string) Object {
	t.Helper()
	for _, template := range subscriptionTemplates {
		if template["id"] == id {
			return clone(template)
		}
	}
	t.Fatal("missing template", id)
	return nil
}
func TestSubscriptionDescriptors(t *testing.T) {
	for _, template := range subscriptionTemplates {
		if err := validateSubscriptionDescriptor(template); err != nil {
			t.Fatal(template["id"], err)
		}
	}
	descriptor := subscriptionFixture(t, "json-website")
	object(descriptor["items"])["path"] = "$.constructor"
	if validateSubscriptionDescriptor(descriptor) == nil {
		t.Fatal("unsafe path accepted")
	}
	for _, address := range []string{"http://status.example.com", "https://127.0.0.1", "https://169.254.169.254", "https://localhost", "https://status.local", "https://user:pass@status.example.com"} {
		if _, err := subscriptionURL(address); err == nil {
			t.Fatal("unsafe URL", address)
		}
	}
	for _, address := range []string{"127.0.0.1", "10.0.0.1", "192.168.1.1", "169.254.169.254"} {
		if _, err := subscriptionURL("https://" + address); err == nil {
			t.Fatal("private IP", address)
		}
	}
}
func TestSubscriptionManagementAndRuntime(t *testing.T) {
	s := newTestServer(t)
	runSubscriptionManagement(t, s)
}

func TestSubscriptionDescriptorCredentialAndPathValidation(t *testing.T) {
	base := subscriptionFixture(t, "json-website")
	for name, change := range map[string]func(Object){
		"nested credential": func(d Object) {
			r := object(object(d["requests"])["status"])
			r["method"] = "POST"
			r["body"] = Object{"auth": []any{Object{"api_key": "private-value"}}}
		},
		"header": func(d Object) { object(object(d["requests"])["status"])["headers"] = Object{"invalid header": "value"} },
		"filter": func(d Object) {
			object(d["items"])["filter"] = Object{"op": "and", "conditions": []any{Object{"op": "exists", "path": "$.__proto__"}}}
		},
		"URL default": func(d Object) { object(object(d["inputs"])["baseUrl"])["default"] = "http://status.example.com" },
		"metrics request": func(d Object) {
			d["metrics"] = Object{"availability": Object{"request": "missing", "path": "$", "unit": "percent", "windowSec": 60}}
		},
	} {
		t.Run(name, func(t *testing.T) {
			d := clone(base)
			change(d)
			if validateSubscriptionDescriptor(clone(d)) == nil {
				t.Fatal("invalid descriptor accepted")
			}
		})
	}
	d := clone(base)
	object(d["inputs"])["token"] = Object{"type": "secret"}
	r := object(object(d["requests"])["status"])
	r["method"] = "POST"
	r["body"] = Object{"auth": []any{Object{"api_key": "{token}"}}, "max_tokens": 100}
	if err := validateSubscriptionDescriptor(clone(d)); err != nil {
		t.Fatal(err)
	}
}

func runSubscriptionManagement(t *testing.T, s *testServer) {
	status := "up"
	var inFlight func()
	s.app.subscriptionClient = &http.Client{Transport: aiRoundTrip(func(r *http.Request) (*http.Response, error) {
		if r.URL.Host != "status.example.com" {
			t.Fatal("unexpected destination", r.URL.Host)
		}
		if inFlight != nil {
			fn := inFlight
			inFlight = nil
			fn()
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"services":[{"id":"api","name":"API","status":"` + status + `"}]}`))}, nil
	})}
	req := func(method, path string, input any, want int) Object {
		t.Helper()
		code, result := s.request(t, method, path, input, true)
		expectStatus(t, code, want, result)
		for _, task := range []struct{ key, route, value string }{{"previewId", "/api/admin/subscription-previews/", "preview"}, {"runId", "/api/admin/subscription-runs/", "run"}} {
			if id := str(result, task.key); id != "" {
				for attempt := 0; attempt < 100; attempt++ {
					_, read := s.request(t, "GET", task.route+id, nil, true)
					result[task.value] = read[task.value]
					if object(read[task.value])["state"] != "running" {
						break
					}
					time.Sleep(5 * time.Millisecond)
				}
			}
		}
		return result
	}
	code, result := s.request(t, "GET", "/api/admin/subscriptions", nil, false)
	expectStatus(t, code, 401, result)
	preview := req("POST", "/api/admin/subscription-configs/preview", Object{"descriptor": subscriptionFixture(t, "json-website"), "parameters": Object{"baseUrl": "https://status.example.com"}}, 202)
	if object(preview["preview"])["state"] != "ready" {
		t.Fatal(preview)
	}
	input := Object{"requestId": "once", "previewId": preview["previewId"], "name": "Fixture source", "category": "website", "selectedIds": []string{"api"}, "isPublic": true}
	row := object(req("POST", "/api/admin/subscriptions", input, 201)["subscription"])
	id := str(row, "id")
	path := "/api/admin/subscriptions/" + id
	if summary := object(req("GET", "/api/admin/subscriptions?q=not-found", nil, 200)["summary"]); integer(summary, "total") != 1 || integer(summary, "items") != 1 {
		t.Fatal(summary)
	}
	if integer(object(object(req("GET", path, nil, 200)["subscription"])["statusCounts"]), "up") != 1 {
		t.Fatal("detail missing status counts")
	}
	if object(object(row["notifications"])["monitor"])["notificationEnabled"] != false {
		t.Fatal("notifications default on")
	}
	if object(req("POST", "/api/admin/subscriptions", input, 200)["subscription"])["id"] != id {
		t.Fatal("duplicate creation")
	}
	items := array(req("GET", path+"/items", nil, 200)["items"])
	if len(items) != 1 {
		t.Fatal(items)
	}
	item := object(items[0])
	index, err := s.app.store.subscriptionItemIndex(context.Background(), id, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(index) != 1 || index[0]["recent"] != nil || index[0]["days"] != nil {
		t.Fatal("list index loaded histories")
	}
	full, err := s.app.store.subscriptionItemsByIndex(context.Background(), index)
	if err != nil || len(full) != 1 || full[0]["recent"] == nil {
		t.Fatal("page hydration missing history", err)
	}
	public := req("GET", "/api/public/subscriptions/items?category=website", nil, 200)
	if len(array(public["items"])) != 1 {
		t.Fatal(public)
	}
	status = "down"
	run := object(req("POST", path+"/sync", Object{}, 202)["run"])
	if run["state"] != "ready" {
		t.Fatal(run)
	}
	item = object(array(req("GET", path+"/items", nil, 200)["items"])[0])
	if object(item["observation"])["status"] != "down" || len(array(item["recent"])) != 2 {
		t.Fatal(item)
	}
	req("PATCH", path+"/items", Object{"items": []Object{{"id": item["id"], "revision": item["revision"], "localName": "Local API", "muted": true}}}, 200)
	inFlight = func() {
		req("PATCH", path, Object{"revision": row["revision"], "name": "Edited during sync", "isPublic": false}, 200)
	}
	req("POST", path+"/sync", Object{}, 202)
	current := object(req("GET", path, nil, 200)["subscription"])
	if current["name"] != "Edited during sync" {
		t.Fatal("runtime overwrote edit")
	}
	if len(array(req("GET", "/api/public/subscriptions/items?category=website", nil, 200)["items"])) != 0 {
		t.Fatal("hidden item still public")
	}
	req("GET", "/api/public/subscriptions/items/"+str(item, "id")+"/history", nil, 404)
	req("PATCH", path, Object{"revision": row["revision"], "name": "stale"}, 409)
	config := object(req("GET", path+"/config", nil, 200)["config"])
	configPreview := req("POST", path+"/config/preview", Object{"revision": current["revision"], "descriptor": config["descriptor"], "parameters": Object{}}, 202)
	req("PUT", path+"/config", Object{"revision": current["revision"], "previewId": preview["previewId"]}, 409)
	updated := object(req("PUT", path+"/config", Object{"revision": current["revision"], "previewId": configPreview["previewId"]}, 200)["subscription"])
	if updated["syncRevision"] == current["syncRevision"] {
		t.Fatal("configuration did not invalidate tasks")
	}
	item = object(array(req("GET", path+"/items", nil, 200)["items"])[0])
	if item["localName"] != "Local API" || item["muted"] != true || item["freshness"] != "configuration_changed" {
		t.Fatal(item)
	}
	identityDescriptor := clone(object(config["descriptor"]))
	object(object(identityDescriptor["items"])["fields"])["id"] = Object{"path": "$.id", "prefix": "new-"}
	identityPreview := req("POST", path+"/config/preview", Object{"revision": updated["revision"], "descriptor": identityDescriptor, "parameters": Object{}}, 202)
	req("PUT", path+"/config", Object{"revision": updated["revision"], "previewId": identityPreview["previewId"]}, 409)
	updated = object(req("PUT", path+"/config", Object{"revision": updated["revision"], "previewId": identityPreview["previewId"], "confirmIdentityChange": true, "identityMappings": []Object{{"itemId": item["id"], "sourceItemId": "new-api"}}}, 200)["subscription"])
	mapped := object(array(req("GET", path+"/items", nil, 200)["items"])[0])
	if mapped["id"] != item["id"] || mapped["sourceItemId"] != "new-api" || encode(mapped["days"]) != encode(item["days"]) {
		t.Fatal("identity remap lost item history")
	}
	inFlight = func() { req("PATCH", path, Object{"revision": updated["revision"], "enabled": false}, 200) }
	obsolete := object(req("POST", path+"/sync", Object{}, 202)["run"])
	if obsolete["state"] != "obsolete" {
		t.Fatal("old run accepted", obsolete)
	}
	current = object(req("GET", path, nil, 200)["subscription"])
	req("DELETE", path, Object{"revision": current["revision"]}, 200)
	req("GET", path, nil, 404)
	status = "unmapped"
	invalidPreview := req("POST", "/api/admin/subscription-configs/preview", Object{"descriptor": subscriptionFixture(t, "json-website"), "parameters": Object{"baseUrl": "https://status.example.com"}}, 202)
	req("POST", "/api/admin/subscriptions", Object{"requestId": "invalid-selection", "previewId": invalidPreview["previewId"], "name": "Invalid", "category": "website", "selectedIds": []string{"api"}}, 400)
	remaining, err := s.app.store.list(context.Background(), "subscription_item")
	if err != nil || len(remaining) != 0 {
		t.Fatal("items leaked", remaining, err)
	}
}

func TestSubscriptionPostgres(t *testing.T) {
	base := os.Getenv("POLARIS_TEST_POSTGRES_URL")
	if base == "" {
		t.Skip("owned PostgreSQL runner required")
	}
	u, err := url.Parse(base)
	if err != nil || u.Hostname() != "127.0.0.1" {
		t.Fatal("owned loopback PostgreSQL required")
	}
	db, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	name := "polaris_sub_" + strings.ReplaceAll(uuid(), "-", "")
	if _, err = db.Exec("CREATE DATABASE " + name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Exec("DROP DATABASE " + name + " WITH (FORCE)") })
	u.Path = "/" + name
	c := DefaultConfig()
	c.DataDir = t.TempDir()
	c.DatabaseURL = u.String()
	c.AdminToken = "fixture-admin"
	c.SetupKey = "fixture-setup"
	keyPath := filepath.Join(c.DataDir, "shared.key")
	material := make([]byte, 32)
	_, _ = rand.Read(material)
	if err := os.WriteFile(keyPath, material, 0600); err != nil {
		t.Fatal(err)
	}
	if err := protectAIKey(keyPath); err != nil {
		t.Fatal(err)
	}
	c.AICredentialKeyFile = keyPath
	s := openTestServer(t, c)
	code, result := s.request(t, "POST", "/api/auth/setup", Object{"credential": c.SetupKey, "username": "subscription-owner", "password": "fixture-owner-secret"}, false)
	expectStatus(t, code, 200, result)
	s.client.Jar, _ = cookiejar.New(nil)
	runSubscriptionManagement(t, s)
}
func TestSubscriptionRuntimeHistory(t *testing.T) {
	now := time.Now().Unix()
	subscription := Object{"id": "s", "category": "website", "syncRevision": "v", "enabled": true, "staleAfterSec": 300}
	point := func(status string, at int64) Object {
		return Object{"status": status, "observedAt": at, "fetchedAt": now, "changedAt": nil}
	}
	source := clone(Object{"sourceItemId": "id", "name": "Service", "mode": "heartbeat", "recent": []Object{point("up", now-60)}, "observation": point("up", now-60)})
	item := mergeSubscriptionItem(newSubscriptionItem(source, subscription, true), source, "v", now)
	item = mergeSubscriptionItem(item, source, "v", now)
	item = clone(item)
	if integer(object(array(item["days"])[0]), "total") != 1 {
		t.Fatal("duplicate observation", item)
	}
	source["recent"] = []any{point("down", now-60)}
	item = clone(mergeSubscriptionItem(item, source, "v", now))
	day := object(array(item["days"])[0])
	if integer(day, "up") != 0 || integer(day, "total") != 1 {
		t.Fatal("correction", day)
	}
	if subscriptionItemView(item, subscription, now+400)["displayStatus"] != "unknown" {
		t.Fatal("stale state shown as current")
	}
}
func TestSubscriptionNotificationPolicy(t *testing.T) {
	channel := Object{"id": "n", "active": true, "group_ids": []any{}}
	for _, test := range []struct {
		event  Object
		reason string
	}{
		{Object{"monitorType": "http"}, ""}, {Object{"subscriptionId": "s"}, "source_outside_scope"},
		{Object{"subscriptionId": "s", "notificationChannelIds": []string{"n"}}, ""},
		{Object{"notificationEnabled": false, "notificationChannelIds": []string{"n"}}, "notifications_disabled"},
	} {
		if actual := notificationRoutingReason(channel, test.event); actual != test.reason {
			t.Fatal(test.event, actual, test.reason)
		}
	}
}

func TestSubscriptionPublicAddresses(t *testing.T) {
	for _, address := range []netip.Addr{
		netip.AddrFrom16([16]byte{0x20, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}),
		netip.AddrFrom16([16]byte{0x20, 0x01, 0, 0x1f, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1}),
		netip.AddrFrom16([16]byte{0x20, 0x02, 0x7f, 0, 0, 1}),
		netip.MustParseAddr("2001:db8::1"), netip.MustParseAddr("::ffff:127.0.0.1"),
	} {
		if publicSubscriptionIP(address) {
			t.Fatal("reserved address accepted", address)
		}
	}
	for _, address := range []netip.Addr{netip.AddrFrom4([4]byte{192, 2, 0, 1}), netip.MustParseAddr("2606:4700:4700::1111")} {
		if !publicSubscriptionIP(address) {
			t.Fatal("public address refused", address)
		}
	}
}

func TestSubscriptionCachedAggregateLimit(t *testing.T) {
	s := newTestServer(t)
	descriptor := subscriptionFixture(t, "json-website")
	cache := Object{}
	for i := 0; i < 6; i++ {
		id := fmt.Sprintf("extra%d", i)
		if i == 0 {
			id = "status"
		}
		object(descriptor["requests"])[id] = clone(object(object(descriptor["requests"])["status"]))
		cache[id] = Object{"value": Object{"data": strings.Repeat("x", 1800000)}, "fetchedAt": time.Now().Unix()}
	}
	_, err := s.app.fetchSubscription(context.Background(), descriptor, Object{"baseUrl": "https://status.example.com"}, cache, false)
	if err == nil || !strings.Contains(err.Error(), "limit_exceeded") {
		t.Fatal("cached aggregate not bounded", err)
	}
}
