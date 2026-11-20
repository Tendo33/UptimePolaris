package polaris

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/XingLingQAQ/uptime/backends/go/internal/updates"
)

func TestUpdateRoutesRequireAdminAndProxyFixedActions(t *testing.T) {
	s := newTestServer(t)
	code, result := s.request(t, "GET", "/api/admin/updates", nil, false)
	expectStatus(t, code, 401, result)
	code, result = s.request(t, "GET", "/api/admin/updates", nil, true)
	expectStatus(t, code, 200, result)
	if result["supported"] != false {
		t.Fatal(result)
	}
	controller := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer update-test-token" {
			t.Error("updater credential missing")
		}
		if r.URL.Path != "/status" && r.URL.Path != "/policy" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		json.NewEncoder(w).Encode(updates.State{Current: "1.0.0", Latest: "v1.1.0", Supported: true, Mode: "native"})
	}))
	defer controller.Close()
	s.app.config.UpdaterURL = controller.URL
	s.app.config.UpdaterToken = "update-test-token"
	code, result = s.request(t, "GET", "/api/admin/updates", nil, true)
	expectStatus(t, code, 200, result)
	if str(result, "current") != updates.Version || str(result, "latest") != "v1.1.0" {
		t.Fatal(result)
	}
	code, result = s.request(t, "PUT", "/api/admin/updates/policy", Object{"automatic": true}, true)
	expectStatus(t, code, 200, result)
	code, result = s.request(t, "POST", "/api/auth/login", Object{"username": "fixture-owner", "password": "fixture-owner-secret"}, false)
	expectStatus(t, code, 200, result)
	request, _ := http.NewRequest("PUT", s.server.URL+"/api/admin/updates/policy", strings.NewReader(`{"automatic":true}`))
	request.Header.Set("Origin", "https://attacker.example")
	response, e := s.client.Do(request)
	if e != nil {
		t.Fatal(e)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("cross-origin update accepted")
	}
}
