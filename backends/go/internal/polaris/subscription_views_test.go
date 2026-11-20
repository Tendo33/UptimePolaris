package polaris

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"testing"
)

func TestSubscriptionSummaryBeyondPage(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	for i := 0; i < 205; i++ {
		id := fmt.Sprintf("source-%03d", i)
		row := Object{"id": id, "name": id, "category": "website", "enabled": i != 0, "archivedAt": nil, "sourceUrl": nil, "runtime": Object{"health": "healthy"}}
		if i == 1 {
			row["archivedAt"] = 1
			row["enabled"] = false
		}
		if err := s.app.store.put(ctx, "subscription", id, row); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.app.store.put(ctx, "subscription_item", "item", Object{"id": "item", "subscriptionId": "source-002", "selected": true, "removedAt": nil}); err != nil {
		t.Fatal(err)
	}
	code, result := s.request(t, "GET", "/api/admin/subscriptions?limit=1&q=none", nil, true)
	expectStatus(t, code, 200, result)
	summary := object(result["summary"])
	if integer(result, "total") != 0 || integer(summary, "total") != 204 || integer(summary, "items") != 1 || integer(summary, "paused") != 1 || integer(summary, "healthy") != 203 {
		t.Fatal(result)
	}
	code, result = s.request(t, "GET", "/api/admin/subscriptions?archived=true&health=paused&limit=1", nil, true)
	expectStatus(t, code, 200, result)
	if integer(result, "total") != 1 || integer(object(result["summary"]), "archived") != 1 {
		t.Fatal(result)
	}
}

func TestSubscriptionIconAccessAndCache(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	row := Object{"id": "source", "name": "Source", "category": "website", "isPublic": true, "archivedAt": nil, "sourceHosts": []string{"status.example.com"}}
	for kind, entry := range map[string]Object{"subscription": row, "subscription_item": {"id": "item", "subscriptionId": "source", "selected": true, "isPublic": true, "removedAt": nil}} {
		id := str(entry, "id")
		if err := s.app.store.put(ctx, kind, id, entry); err != nil {
			t.Fatal(err)
		}
	}
	png := []byte{137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0}
	reads := 0
	s.app.subscriptionClient = &http.Client{Transport: aiRoundTrip(func(r *http.Request) (*http.Response, error) {
		reads++
		if r.URL.String() != "https://status.example.com/favicon.ico" {
			t.Fatal(r.URL)
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Content-Type": []string{"image/png"}}, Body: io.NopCloser(bytes.NewReader(png))}, nil
	})}
	read := func(path string, admin bool, want int) {
		t.Helper()
		req, _ := http.NewRequest("GET", s.server.URL+path, nil)
		if admin {
			req.Header.Set("Authorization", "Bearer "+s.config.AdminToken)
		}
		res, err := s.client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer res.Body.Close()
		raw, _ := io.ReadAll(res.Body)
		if res.StatusCode != want {
			t.Fatalf("%s: %d %s", path, res.StatusCode, raw)
		}
		if want == 200 && (res.Header.Get("Content-Type") != "image/png" || res.Header.Get("Cache-Control") != "private, no-store" || !bytes.Equal(raw, png)) {
			t.Fatal(res.Header, raw)
		}
	}
	read("/api/admin/subscriptions/source/icon", false, 401)
	read("/api/admin/subscriptions/source/icon", true, 404)
	if err := s.app.store.put(ctx, "config", "settings", Object{"site.syncMonitorIcons": true}); err != nil {
		t.Fatal(err)
	}
	read("/api/admin/subscriptions/source/icon", true, 200)
	read("/api/public/subscriptions/icons/source", false, 200)
	if reads != 1 {
		t.Fatal("cache missed", reads)
	}
	row["isPublic"] = false
	if err := s.app.store.put(ctx, "subscription", "source", row); err != nil {
		t.Fatal(err)
	}
	read("/api/public/subscriptions/icons/source", false, 404)
	row["isPublic"] = true
	row["category"] = "model"
	if err := s.app.store.put(ctx, "subscription", "source", row); err != nil {
		t.Fatal(err)
	}
	read("/api/public/subscriptions/icons/source", false, 404)
}

func TestSubscriptionIconDiscoveryAndLimits(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	source, _ := url.Parse("https://status.example.com/")
	for _, scenario := range []string{"html", "oversize", "svg", "redirect"} {
		t.Run(scenario, func(t *testing.T) {
			calls := 0
			s.app.subscriptionClient = &http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }, Transport: aiRoundTrip(func(r *http.Request) (*http.Response, error) {
				calls++
				body, kind, status := "", "text/html", 200
				headers := http.Header{}
				switch scenario {
				case "html":
					if r.URL.Path == "/favicon.ico" {
						status = 404
					} else if r.URL.Path == "/" {
						body = `<link rel="icon" href="/logo.png">` + strings.Repeat("x", 100000)
					} else {
						body = string([]byte{137, 80, 78, 71, 13, 10, 26, 10})
						kind = "image/png"
					}
				case "oversize":
					body = strings.Repeat("x", 256*1024+1)
					kind = "image/png"
				case "svg":
					body = `<svg onload="alert(1)"></svg>`
					kind = "image/svg+xml"
				case "redirect":
					if r.URL.Host != "status.example.com" {
						t.Fatal("unsafe destination reached")
					}
					status = 302
					headers.Set("Location", "https://127.0.0.1/favicon.ico")
				}
				headers.Set("Content-Type", kind)
				return &http.Response{StatusCode: status, Header: headers, Body: io.NopCloser(strings.NewReader(body))}, nil
			})}
			_, kind := s.app.fetchSubscriptionIcon(ctx, source)
			if scenario == "html" {
				if kind != "image/png" || calls != 3 {
					t.Fatal(kind, calls)
				}
			} else if kind != "" {
				t.Fatal("invalid icon accepted", kind)
			}
		})
	}
}
