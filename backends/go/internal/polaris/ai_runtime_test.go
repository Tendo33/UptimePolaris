package polaris

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func runtimeFixture(t *testing.T, s *testServer) (func(string) Object, func(Object, string, Object) Object, func(string), *atomic.Int64, *atomic.Int64) {
	t.Helper()
	ctx := context.Background()
	if err := s.app.store.mutate(ctx, func(tx *transaction) error {
		cfg := defaultPresentation()
		cfg["aiEnabled"] = true
		return tx.put("config", "presentation", Object{"config": cfg, "revision": uuid()})
	}); err != nil {
		t.Fatal(err)
	}
	createChannel := func(name string) Object {
		code, result := s.request(t, "POST", "/api/admin/ai/channels", Object{"name": name, "baseUrl": "https://provider.example/custom/v1", "protocol": "openai", "apiKey": "fixture-runtime-key"}, true)
		expectStatus(t, code, 201, result)
		return object(result["channel"])
	}
	createModel := func(channel Object, name string, extra Object) Object {
		input := Object{"channelId": channel["id"], "name": name, "modelId": name, "timeoutMs": 1000}
		for key, value := range extra {
			input[key] = value
		}
		code, result := s.request(t, "POST", "/api/admin/ai/models", input, true)
		expectStatus(t, code, 201, result)
		return object(result["model"])
	}
	force := func(id string) {
		err := s.app.store.mutate(ctx, func(tx *transaction) error {
			live, err := tx.get("ai_live", id)
			if err != nil {
				return err
			}
			if live != nil {
				live["nextCheckAt"] = 0
				if err = tx.put("ai_live", id, live); err != nil {
					return err
				}
			}
			model, err := tx.get("ai_model", id)
			if err != nil {
				return err
			}
			return tx.remove("ai_cooldown", str(model, "channelId"))
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	return createChannel, createModel, force, &atomic.Int64{}, &atomic.Int64{}
}
func TestAIRuntimeScheduling(t *testing.T) {
	s := newTestServer(t)
	runRuntimeScheduling(t, s)
}
func runRuntimeScheduling(t *testing.T, s *testServer) {
	ctx := context.Background()
	createChannel, createModel, force, calls, status := runtimeFixture(t, s)
	status.Store(200)
	var mutation func()
	var hold chan struct{}
	started := make(chan struct{}, 1)
	s.app.aiClient = &http.Client{Transport: aiRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.URL.String() != "https://provider.example/custom/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer fixture-runtime-key" {
			t.Error("invalid scheduled request")
		}
		var body Object
		_ = json.NewDecoder(r.Body).Decode(&body)
		if number(body["max_tokens"]) != 64 {
			t.Error(body)
		}
		if hold != nil {
			select {
			case started <- struct{}{}:
			default:
			}
			<-hold
		}
		if mutation != nil {
			fn := mutation
			mutation = nil
			fn()
		}
		data := `{"choices":[{"message":{"content":"OK"}}]}`
		if status.Load() != 200 {
			data = `{"error":{"message":"fixture-runtime-key","code":"rate_limit_exceeded"}}`
		}
		return &http.Response{StatusCode: int(status.Load()), Header: http.Header{"Retry-After": []string{"7200"}}, Body: io.NopCloser(strings.NewReader(data))}, nil
	})}
	channel := createChannel("Schedule")
	model := createModel(channel, "model", Object{"isPublic": true})
	s.app.cycle(ctx, true)
	if calls.Load() != 1 {
		t.Fatal("AI-only cycle did not run", calls.Load())
	}
	live, _ := s.app.store.get(ctx, "ai_live", str(model, "id"))
	if integer(live, "total") != 1 || integer(live, "ok") != 1 || integer(live, "checkedAt") == 0 {
		t.Fatal(live)
	}
	s.app.aiCycle(ctx, true)
	if calls.Load() != 1 {
		t.Fatal("interval ignored")
	}
	force(str(model, "id"))
	status.Store(429)
	s.app.aiCycle(ctx, true)
	live, _ = s.app.store.get(ctx, "ai_live", str(model, "id"))
	if integer(live, "total") != 2 || integer(live, "ok") != 1 || integer(live, "nextCheckAt") < time.Now().Unix()+7199 {
		t.Fatal(live)
	}
	second := createModel(channel, "cooldown", nil)
	s.app.aiCycle(ctx, true)
	if calls.Load() != 2 {
		t.Fatal("channel quota storm", calls.Load())
	}
	deferred, _ := s.app.store.get(ctx, "ai_live", str(second, "id"))
	if deferred["skipReason"] != "channel_backoff" || integer(deferred, "total") != 0 {
		t.Fatal(deferred)
	}
	newChannel := createChannel("Overlap")
	active := createModel(newChannel, "overlap", nil)
	status.Store(200)
	hold = make(chan struct{})
	done := make(chan struct{})
	go func() { s.app.aiCycle(ctx, true); close(done) }()
	<-started
	s.app.aiCycle(ctx, true)
	if calls.Load() != 3 {
		t.Fatal("overlapping lease duplicated call", calls.Load())
	}
	close(hold)
	<-done
	hold = nil
	force(str(active, "id"))
	mutation = func() {
		input := clone(active)
		input["modelId"] = "changed"
		code, result := s.request(t, "PUT", "/api/admin/ai/models/"+str(active, "id"), input, true)
		expectStatus(t, code, 200, result)
		active = object(result["model"])
	}
	s.app.aiCycle(ctx, true)
	view, err := s.app.aiModelView(ctx, active)
	if err != nil || object(view["live"])["freshness"] != "configuration_changed" {
		t.Fatal(view, err)
	}
	points, err := s.app.readings(ctx, "ai:"+str(active, "id"), 0, 100)
	if err != nil || len(points) != 1 {
		t.Fatal("old result persisted", len(points), err)
	}
	s.app.aiCycle(ctx, true)
	active, _ = s.app.store.get(ctx, "ai_model", str(active, "id"))
	force(str(active, "id"))
	mutation = func() {
		input := clone(active)
		input["enabled"] = false
		code, result := s.request(t, "PUT", "/api/admin/ai/models/"+str(active, "id"), input, true)
		expectStatus(t, code, 200, result)
		active = object(result["model"])
	}
	s.app.aiCycle(ctx, true)
	before := calls.Load()
	s.app.aiCycle(ctx, true)
	if calls.Load() != before {
		t.Fatal("paused model probed")
	}
	code, result := s.request(t, "GET", "/api/public/ai/models/"+str(active, "id")+"/history", nil, false)
	expectStatus(t, code, 404, result)
	keyChannel := createChannel("Key unavailable")
	keyModel := createModel(keyChannel, "key", nil)
	bad := clone(keyChannel)
	stored, _ := s.app.store.get(ctx, "ai_channel", str(keyChannel, "id"))
	bad = clone(stored)
	bad["credential_ciphertext"] = "broken"
	if err = s.app.store.put(ctx, "ai_channel", str(bad, "id"), bad); err != nil {
		t.Fatal(err)
	}
	before = calls.Load()
	s.app.aiCycle(ctx, true)
	if calls.Load() != before {
		t.Fatal("unavailable credential sent")
	}
	skipped, _ := s.app.store.get(ctx, "ai_live", str(keyModel, "id"))
	if skipped["skipReason"] != "credential_unavailable" || integer(skipped, "total") != 0 {
		t.Fatal(skipped)
	}
	deleteChannel := createChannel("Delete")
	deleting := createModel(deleteChannel, "delete", nil)
	mutation = func() {
		code, result := s.request(t, "DELETE", "/api/admin/ai/models/"+str(deleting, "id"), Object{"revision": deleting["revision"]}, true)
		expectStatus(t, code, 200, result)
	}
	s.app.aiCycle(ctx, true)
	points, _ = s.app.readings(ctx, "ai:"+str(deleting, "id"), 0, 100)
	if len(points) != 0 {
		t.Fatal("deleted model got history")
	}
}

func TestAIRuntimePostgres(t *testing.T) {
	base := os.Getenv("POLARIS_TEST_POSTGRES_URL")
	if base == "" {
		t.Skip("owned PostgreSQL fixture required")
	}
	u, err := url.Parse(base)
	if err != nil || u.Hostname() != "127.0.0.1" {
		t.Fatal("owned loopback PostgreSQL required")
	}
	db, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	name := "ai_runtime_" + strings.ReplaceAll(uuid(), "-", "")
	if _, err = db.Exec("CREATE DATABASE " + name); err != nil {
		t.Fatal(err)
	}
	defer db.Exec("DROP DATABASE " + name + " WITH (FORCE)")
	u.Path = "/" + name
	config := DefaultConfig()
	config.DataDir = t.TempDir()
	config.DatabaseURL = u.String()
	config.AdminToken = "fixture-admin"
	config.SetupKey = "fixture-setup"
	config.AICredentialKeyFile = filepath.Join(t.TempDir(), "key")
	material := make([]byte, 32)
	_, _ = rand.Read(material)
	if err = os.WriteFile(config.AICredentialKeyFile, material, 0600); err != nil {
		t.Fatal(err)
	}
	if err = protectAIKey(config.AICredentialKeyFile); err != nil {
		t.Fatal(err)
	}
	s := openTestServer(t, config)
	code, result := s.request(t, "POST", "/api/auth/setup", Object{"credential": config.SetupKey, "username": "fixture-owner", "password": "fixture-owner-secret"}, false)
	expectStatus(t, code, 200, result)
	runRuntimeScheduling(t, s)
}

func TestAIRuntimeNotificationsAndHistory(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	createChannel, createModel, force, _, status := runtimeFixture(t, s)
	status.Store(503)
	s.app.aiClient = &http.Client{Transport: aiRoundTrip(func(*http.Request) (*http.Response, error) {
		body := `{"error":{"message":"fixture-runtime-key"}}`
		if status.Load() == 200 {
			body = `{"choices":[{"message":{"content":"OK"}}]}`
		}
		return &http.Response{StatusCode: int(status.Load()), Header: http.Header{}, Body: io.NopCloser(strings.NewReader(body))}, nil
	})}
	channel := createChannel("Notify")
	notification := Object{"id": "existing-channel", "active": true, "type": "webhook", "config": Object{"url": "https://notify.example"}, "group_ids": []string{"ordinary-group"}}
	if err := s.app.store.put(ctx, "notification", "existing-channel", notification); err != nil {
		t.Fatal(err)
	}
	savedChannel, err := s.app.store.get(ctx, "ai_channel", str(channel, "id"))
	if err != nil {
		t.Fatal(err)
	}
	savedChannel["notificationChannelIds"] = []string{"existing-channel"}
	if err := s.app.store.put(ctx, "ai_channel", str(channel, "id"), savedChannel); err != nil {
		t.Fatal(err)
	}
	model := createModel(channel, "notify", Object{})
	if err := s.app.store.put(ctx, "config", "settings", Object{"maintenance.enabled": true, "monitor.defaultRetries": 3}); err != nil {
		t.Fatal(err)
	}
	for range 3 {
		force(str(model, "id"))
		s.app.aiCycle(ctx, true)
	}
	live, _ := s.app.store.get(ctx, "ai_live", str(model, "id"))
	if integer(live, "total") != 3 || integer(live, "ok") != 0 || !boolean(live["alertPending"]) {
		t.Fatal(live)
	}
	outbox, _ := s.app.store.list(ctx, "outbox")
	if len(outbox) != 0 {
		t.Fatal("maintenance leaked alert")
	}
	if err := s.app.store.put(ctx, "config", "settings", Object{"maintenance.enabled": false, "monitor.defaultRetries": 3}); err != nil {
		t.Fatal(err)
	}
	s.app.aiCycle(ctx, true)
	outbox, _ = s.app.store.list(ctx, "outbox")
	if len(outbox) != 1 {
		t.Fatal("held alert not queued", len(outbox))
	}
	if integer(object(outbox[0]["event"]), "status") != 0 {
		t.Fatal(outbox)
	}
	s.app.aiCycle(ctx, true)
	outbox, _ = s.app.store.list(ctx, "outbox")
	if len(outbox) != 1 {
		t.Fatal("duplicate alert")
	}
	status.Store(200)
	force(str(model, "id"))
	s.app.aiCycle(ctx, true)
	outbox, _ = s.app.store.list(ctx, "outbox")
	if len(outbox) != 2 {
		t.Fatal("recovery not queued")
	}
	history, err := s.app.aiHistory(ctx, str(model, "id"), 7)
	if err != nil {
		t.Fatal(err)
	}
	days := history["days"].([]Object)
	if len(days) != 1 || integer(object(days[0]), "total") != 4 || integer(object(days[0]), "ok") != 1 || object(days[0])["availabilityPct"] != float64(25) {
		t.Fatal(history)
	}
	if len(history["points"].([]Object)) != 4 {
		t.Fatal("raw observations missing", history)
	}
	live, _ = s.app.store.get(ctx, "ai_live", str(model, "id"))
	old := time.Now().Add(-24 * time.Hour).UTC().Format("2006-01-02")
	live["day"] = Object{"date": old, "total": 3, "ok": 1, "latencyTotalMs": 15}
	if err = s.app.store.put(ctx, "ai_live", str(model, "id"), live); err != nil {
		t.Fatal(err)
	}
	if err = s.app.archiveAIHistory(ctx, time.Now().Unix(), 400); err != nil {
		t.Fatal(err)
	}
	if err = s.app.archiveAIHistory(ctx, time.Now().Unix(), 400); err != nil {
		t.Fatal(err)
	}
	archived, _ := s.app.store.list(ctx, "ai_day")
	if len(archived) != 1 || integer(archived[0], "total") != 3 || archived[0]["availabilityPct"] != float64(100)/3 {
		t.Fatal(archived)
	}
	view, _ := s.app.aiModelView(ctx, model)
	if object(view["live"])["availabilityPct"] != float64(25) {
		t.Fatal(view)
	}
	code, result := s.request(t, "GET", "/api/public/ai/models", nil, false)
	expectStatus(t, code, 200, result)
	if len(array(result["models"])) != 0 {
		t.Fatal("private model public")
	}
	input := clone(model)
	input["isPublic"] = true
	code, result = s.request(t, "PUT", "/api/admin/ai/models/"+str(model, "id"), input, true)
	expectStatus(t, code, 200, result)
	model = object(result["model"])
	code, result = s.request(t, "GET", "/api/public/ai/models", nil, false)
	expectStatus(t, code, 200, result)
	if len(array(result["models"])) != 1 || strings.Contains(encode(result), "baseUrl") || strings.Contains(encode(result), "channelId") || strings.Contains(encode(result), "notificationChannelIds") {
		t.Fatal(result)
	}
	current, err := s.app.aiNotificationCurrent(ctx, object(outbox[0]["event"]), "existing-channel")
	if err != nil || !current {
		t.Fatal("visibility change cancelled a valid alert", err)
	}
	input = clone(model)
	input["request"] = Object{"prompt": "Reply READY.", "maxOutputTokens": 64, "expectedText": ""}
	code, result = s.request(t, "PUT", "/api/admin/ai/models/"+str(model, "id"), input, true)
	expectStatus(t, code, 200, result)
	current, err = s.app.aiNotificationCurrent(ctx, object(outbox[0]["event"]), "existing-channel")
	if err != nil || current {
		t.Fatal("changed configuration alert not cancelled", err)
	}
	code, result = s.request(t, "GET", "/api/public/ai/models?preview=monitor", nil, false)
	expectStatus(t, code, 401, result)
}

func TestAIRuntimeProtocol(t *testing.T) {
	data, err := os.ReadFile("../../../../test/fixtures/ai-runtime-contract.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		Name  string
		Steps []struct {
			Status              int
			Body                Object
			Outcome             string
			RetryAfter, Backoff int64
		}
		Total, OK int64
		Settled   string
	}
	if err = json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		t.Run(fixture.Name, func(t *testing.T) {
			s := newTestServer(t)
			createChannel, createModel, force, _, _ := runtimeFixture(t, s)
			channel := createChannel("Protocol")
			model := createModel(channel, "protocol", nil)
			for _, step := range fixture.Steps {
				if got := classifyAIResponse(step.Status, step.Body, "openai"); got != step.Outcome {
					t.Fatal(got, step.Outcome)
				}
				if got := aiBackoff(step.Outcome, 300, step.RetryAfter); got != step.Backoff {
					t.Fatal(got, step.Backoff)
				}
				s.app.aiClient = &http.Client{Transport: aiRoundTrip(func(*http.Request) (*http.Response, error) {
					return &http.Response{StatusCode: step.Status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(encode(step.Body)))}, nil
				})}
				force(str(model, "id"))
				s.app.aiCycle(context.Background(), true)
			}
			live, err := s.app.store.get(context.Background(), "ai_live", str(model, "id"))
			if err != nil || integer(live, "total") != fixture.Total || integer(live, "ok") != fixture.OK || live["settled"] != fixture.Settled {
				t.Fatal(live, err)
			}
		})
	}
}

type aiBrokenReader struct{}

func (aiBrokenReader) Read([]byte) (int, error) { return 0, io.ErrUnexpectedEOF }
func TestAIRuntimeHeaders(t *testing.T) {
	for _, tc := range []struct {
		status  int
		outcome string
	}{{401, "authentication_failed"}, {429, "rate_limit_or_quota"}} {
		client := &http.Client{Transport: aiRoundTrip(func(*http.Request) (*http.Response, error) {
			return &http.Response{StatusCode: tc.status, Header: http.Header{"Retry-After": []string{"7200"}}, Body: io.NopCloser(aiBrokenReader{})}, nil
		})}
		result := probeAIModel(context.Background(), aiProbeConfig{Protocol: "openai", BaseURL: "https://provider.example/v1", APIKey: "fixture-runtime-key", Model: "fixture", TimeoutMS: 1000}, client)
		if result.Outcome != tc.outcome || tc.status == 429 && result.RetryAfterSec != 7200 {
			t.Fatal(result)
		}
	}
	if aiNextCheckAt(1700000000, 9007199254740991) != 9007199254740991 {
		t.Fatal("retry delay overflow")
	}
}

func TestAIRuntimeFence(t *testing.T) {
	s := newTestServer(t)
	createChannel, createModel, _, calls, _ := runtimeFixture(t, s)
	channel := createChannel("Fence")
	model := createModel(channel, "fenced", nil)
	s.app.aiClient = &http.Client{Transport: aiRoundTrip(func(*http.Request) (*http.Response, error) {
		if calls.Add(1) == 1 {
			if _, err := s.app.store.db.Exec(s.app.store.query(`UPDATE polaris_leases SET expires_at=0 WHERE id=?`), "ai-channel:"+str(channel, "id")); err != nil {
				t.Error(err)
			}
		}
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"choices":[{"message":{"content":"OK"}}]}`))}, nil
	})}
	s.app.aiCycle(context.Background(), true)
	points, _ := s.app.readings(context.Background(), "ai:"+str(model, "id"), 0, 100)
	if len(points) != 0 {
		t.Fatal("expired owner wrote observation")
	}
	s.app.aiCycle(context.Background(), true)
	entry, _ := s.app.store.get(context.Background(), "ai_live", str(model, "id"))
	if integer(entry, "total") != 1 || calls.Load() != 2 {
		t.Fatal(entry, calls.Load())
	}
}
