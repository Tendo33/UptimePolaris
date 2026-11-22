package polaris

import (
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestSubscriptionRepositories(t *testing.T) {
	s := newTestServer(t)
	descriptor := subscriptionFixture(t, "json-website")
	entry := Object{"id": descriptor["id"], "name": "Fixture", "description": "", "categories": []string{"website"}, "kind": "template", "version": "1.0.0", "path": "templates/json-website/1.0.0.json", "capabilities": descriptor["capabilities"], "limitations": []any{}}
	for _, path := range []string{"../secrets.json", "https://private.net/x.json", "templates/a/2.0.0.json"} {
		bad := clone(entry)
		bad["path"] = path
		if _, err := parseSubscriptionCatalog(Object{"schemaVersion": 1, "entries": []any{bad}}); err == nil {
			t.Fatal("unsafe catalog path accepted", path)
		}
	}
	for _, address := range []string{"http://status.example.com/catalog.json", "https://127.0.0.1/catalog.json", "https://user:pass@status.example.com/catalog.json", "https://status.example.com/catalog.json?token=x"} {
		if _, err := subscriptionRepositoryURL(address); err == nil {
			t.Fatal("unsafe repository accepted", address)
		}
	}
	offline := false
	s.app.subscriptionClient = &http.Client{Transport: aiRoundTrip(func(r *http.Request) (*http.Response, error) {
		value := Object{"schemaVersion": 1, "entries": []any{entry}}
		if r.URL.Host != "status.example.com" && r.URL.Host != "raw.githubusercontent.com" {
			t.Fatal("unexpected host", r.URL.Host)
		}
		if strings.HasSuffix(r.URL.Path, "1.0.0.json") {
			value = descriptor
		}
		status := 200
		if offline && r.URL.Host == "status.example.com" {
			status = 503
		}
		return &http.Response{StatusCode: status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(encode(value)))}, nil
	})}
	req := func(method, path string, input any, want int) Object {
		t.Helper()
		code, result := s.request(t, method, path, input, true)
		expectStatus(t, code, want, result)
		return result
	}
	a := req("POST", "/api/admin/subscription-repositories", Object{"name": "A", "url": "https://status.example.com/a/catalog.json"}, 201)
	b := req("POST", "/api/admin/subscription-repositories", Object{"name": "B", "url": "https://status.example.com/b/catalog.json"}, 201)
	req("POST", "/api/admin/subscription-repositories", Object{"name": "A", "url": "https://status.example.com/a/catalog.json"}, 409)
	listed := req("GET", "/api/admin/subscription-catalog", nil, 200)
	ids := []string{}
	for _, raw := range array(listed["entries"]) {
		e := object(raw)
		if e["origin"] == "third-party" {
			ids = append(ids, str(e, "id"))
		}
	}
	if len(ids) != 2 || ids[0] == ids[1] || len(array(listed["repositories"])) != 2 {
		t.Fatal("repository isolation failed", listed)
	}
	for _, id := range ids {
		result := req("GET", "/api/admin/subscription-catalog/"+url.PathEscape(id), nil, 200)
		if object(result["descriptor"])["id"] != descriptor["id"] {
			t.Fatal(result)
		}
	}
	offline = true
	refreshed := req("POST", "/api/admin/subscription-catalog/refresh", nil, 200)
	for _, raw := range array(refreshed["repositories"]) {
		if !boolean(object(raw)["stale"]) {
			t.Fatal("cached repository not marked stale")
		}
	}
	for _, raw := range array(req("GET", "/api/admin/subscription-catalog", nil, 200)["repositories"]) {
		if !boolean(object(raw)["stale"]) {
			t.Fatal("failed refresh status was not persisted")
		}
	}
	req("DELETE", "/api/admin/subscription-repositories/"+str(object(a["repository"]), "id"), nil, 200)
	if str(object(a["repository"]), "id") == str(object(b["repository"]), "id") {
		t.Fatal("duplicate repository ID")
	}
	for _, id := range ids {
		if strings.HasPrefix(id, str(object(a["repository"]), "id")+":") {
			req("GET", "/api/admin/subscription-catalog/"+url.PathEscape(id), nil, 404)
		}
	}
}
