package polaris

import (
	"bytes"
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/json"
	"io"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func runAIManagement(t *testing.T, s *testServer) {
	if err := s.app.store.mutate(context.Background(), func(tx *transaction) error {
		cfg := defaultPresentation()
		cfg["aiEnabled"] = true
		return tx.put("config", "presentation", Object{"config": cfg, "revision": uuid()})
	}); err != nil {
		t.Fatal(err)
	}
	t.Helper()
	const prefix = "/api/admin/ai/"
	var calls atomic.Int64
	expectedKey, nextStatus, nextBody := "fixture-api-key-first", 200, `{"choices":[{"message":{"content":"OK"}}]}`
	var inFlight func()
	s.app.aiClient = &http.Client{Transport: aiRoundTrip(func(r *http.Request) (*http.Response, error) {
		calls.Add(1)
		if r.Header.Get("Authorization") != "Bearer "+expectedKey {
			t.Error("credential was not preserved/replaced")
		}
		want := "https://provider.example/custom%2Ftenant/v1/chat/completions"
		if r.Method == "GET" {
			want = "https://provider.example/custom%2Ftenant/v1/models"
		}
		if r.URL.String() != want {
			t.Errorf("path changed: %s", r.URL)
		}
		if inFlight != nil {
			fn := inFlight
			inFlight = nil
			fn()
		}
		return &http.Response{StatusCode: nextStatus, Header: http.Header{"Location": []string{"https://attacker.example"}}, Body: io.NopCloser(strings.NewReader(nextBody))}, nil
	})}
	req := func(method, path string, input any, want int, code string) Object {
		status, result := s.request(t, method, path, input, true)
		expectStatus(t, status, want, result)
		if code != "" && result["error"] != code {
			t.Fatalf("error %s, want %s", encode(result), code)
		}
		if strings.Contains(encode(result), "fixture-api-key") || strings.Contains(encode(result), "credential_ciphertext") || strings.Contains(encode(result), `"apiKey"`) {
			t.Fatal("credential leaked")
		}
		return result
	}
	for _, kind := range []string{"channels", "models"} {
		for _, method := range []string{"GET", "POST", "PUT", "DELETE"} {
			path := prefix + kind
			if method == "PUT" || method == "DELETE" {
				path += "/missing"
			}
			status, result := s.request(t, method, path, Object{}, false)
			expectStatus(t, status, 401, result)
		}
	}
	input := Object{"name": "Fixture", "baseUrl": "https://provider.example/custom%2Ftenant/v1/", "protocol": "openai", "apiKey": expectedKey}
	bad := clone(input)
	delete(bad, "apiKey")
	req("POST", prefix+"channels", bad, 400, "api_key_required")
	bad = clone(input)
	bad["baseUrl"] = "https://169.254.169.254/v1"
	req("POST", prefix+"channels", bad, 400, "invalid_ai_url")
	channel := object(req("POST", prefix+"channels", input, 201, "")["channel"])
	if channel["hasApiKey"] != true || channel["baseUrl"] != input["baseUrl"] || channel["notificationEnabled"] != true || len(channel) != 11 {
		t.Fatal(channel)
	}
	channelPath := prefix + "channels/" + str(channel, "id")
	stored, err := s.app.store.get(context.Background(), "ai_channel", str(channel, "id"))
	if err != nil {
		t.Fatal(err)
	}
	ciphertext := str(stored, "credential_ciphertext")
	if !strings.HasPrefix(ciphertext, "v1.") || strings.Contains(encode(stored), expectedKey) {
		t.Fatal("plaintext persisted")
	}
	plain, err := s.app.decryptAICredential(context.Background(), stored)
	if err != nil || plain != expectedKey {
		t.Fatal("encryption read failed", err)
	}
	copy := clone(stored)
	copy["id"] = "swapped"
	if _, err = s.app.decryptAICredential(context.Background(), copy); err == nil {
		t.Fatal("ciphertext transplant accepted")
	}
	req("POST", prefix+"channels", input, 409, "duplicate_channel_name")
	keep := clone(input)
	delete(keep, "apiKey")
	keep["revision"] = channel["revision"]
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for range 2 {
		wg.Add(1)
		go func() { defer wg.Done(); status, _ := s.request(t, "PUT", channelPath, keep, true); statuses <- status }()
	}
	wg.Wait()
	close(statuses)
	success, conflicts := 0, 0
	for status := range statuses {
		if status == 200 {
			success++
		} else if status == 409 {
			conflicts++
		}
	}
	if success != 1 || conflicts != 1 {
		t.Fatal("concurrent write was not rejected", success, conflicts)
	}
	channel = object(req("GET", channelPath, nil, 200, "")["channel"])
	after, _ := s.app.store.get(context.Background(), "ai_channel", str(channel, "id"))
	if after["credential_ciphertext"] != ciphertext {
		t.Fatal("keep changed key")
	}
	req("DELETE", channelPath, Object{"revision": keep["revision"]}, 409, "revision_conflict")
	replacement := clone(input)
	replacement["apiKey"], replacement["revision"] = "fixture-api-key-second", channel["revision"]
	channel = object(req("PUT", channelPath, replacement, 200, "")["channel"])
	expectedKey = str(replacement, "apiKey")
	modelInput := Object{"channelId": channel["id"], "name": "Model", "modelId": "fixture-model"}
	bad = clone(modelInput)
	bad["channelId"] = "missing"
	req("POST", prefix+"models", bad, 404, "not_found")
	model := object(req("POST", prefix+"models", modelInput, 201, "")["model"])
	modelPath := prefix + "models/" + str(model, "id")
	if model["recent"] == nil || integer(model, "intervalSec") != 300 || integer(model, "timeoutMs") != 30000 || model["enabled"] != true || model["isPublic"] != false {
		t.Fatal(model)
	}
	bad = clone(modelInput)
	bad["name"] = "Other"
	req("POST", prefix+"models", bad, 409, "duplicate_model")
	bad = clone(modelInput)
	bad["modelId"] = "Other"
	req("POST", prefix+"models", bad, 409, "duplicate_model")
	bad = clone(model)
	bad["enabled"] = 0
	req("PUT", modelPath, bad, 400, "invalid_request")
	paused := clone(model)
	paused["enabled"], paused["isPublic"] = false, true
	model = object(req("PUT", modelPath, paused, 200, "")["model"])
	req("PUT", modelPath, paused, 409, "revision_conflict")
	check := Object{"revision": model["revision"], "channelRevision": channel["revision"]}
	req("POST", modelPath+"/check", check, 400, "paid_confirmation_required")
	if calls.Load() != 0 {
		t.Fatal("unconfirmed billable call")
	}
	nextBody = `{"data":[]}`
	result := object(req("POST", channelPath+"/test", Object{"revision": channel["revision"]}, 200, "")["result"])
	if result["kind"] != "channel" || result["outcome"] != "ok" {
		t.Fatal(result)
	}
	nextStatus = 404
	result = object(req("POST", channelPath+"/test", Object{"revision": channel["revision"]}, 200, "")["result"])
	if result["outcome"] != "models_endpoint_unsupported" {
		t.Fatal(result)
	}
	check["confirmPaid"] = true
	for _, tc := range []struct {
		status        int
		body, outcome string
	}{
		{200, `{"choices":[{"message":{"content":"OK"}}]}`, "ok"},
		{401, `{"error":{"message":"fixture-api-key-second"}}`, "authentication_failed"},
		{429, `{"error":{"code":"insufficient_quota","message":"fixture-api-key-second"}}`, "quota_exhausted"},
		{302, `{}`, "unexpected_status"},
	} {
		nextStatus, nextBody = tc.status, tc.body
		result = object(req("POST", modelPath+"/check", check, 200, "")["result"])
		if result["kind"] != "model" || result["outcome"] != tc.outcome || result["revision"] != model["revision"] || integer(result, "checkedAt") == 0 {
			t.Fatal(result)
		}
	}
	if calls.Load() != 6 {
		t.Fatal("redirect followed", calls.Load())
	}
	bad = clone(check)
	bad["revision"] = "stale"
	req("POST", modelPath+"/check", bad, 409, "revision_conflict")
	if calls.Load() != 6 {
		t.Fatal("stale config checked")
	}
	inFlight = func() {
		change := clone(model)
		change["name"] = "Changed during check"
		model = object(req("PUT", modelPath, change, 200, "")["model"])
	}
	req("POST", modelPath+"/check", check, 409, "revision_conflict")
	checkedModel := object(req("GET", modelPath, nil, 200, "")["model"])
	if len(array(checkedModel["recent"])) != 0 || integer(object(checkedModel["live"]), "total") != 0 {
		t.Fatal("manual check invented history")
	}

	code, login := s.request(t, "POST", "/api/auth/login", Object{"username": "fixture-owner", "password": "fixture-owner-secret"}, false)
	expectStatus(t, code, 200, login)
	code, _ = s.request(t, "GET", channelPath, nil, false)
	if code != 200 {
		t.Fatal("session authentication failed")
	}
	r, _ := http.NewRequest("PUT", s.server.URL+channelPath, strings.NewReader(encode(keep)))
	r.Header.Set("Origin", "https://attacker.example")
	response, err := s.client.Do(r)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("cross-origin cookie write accepted")
	}
	s.client.Jar, _ = cookiejar.New(nil)

	req("DELETE", modelPath, Object{"revision": model["revision"]}, 200, "")
	req("GET", modelPath, nil, 404, "not_found")
	req("POST", prefix+"models", modelInput, 201, "")
	req("DELETE", channelPath, Object{"revision": channel["revision"]}, 200, "")
	if len(array(req("GET", prefix+"models", nil, 200, "")["models"])) != 0 {
		t.Fatal("cascade left models")
	}
	data, err := os.ReadFile("../../../../test/fixtures/ai-protocols.json")
	if err != nil {
		t.Fatal(err)
	}
	var protocols []Object
	if err := json.Unmarshal(data, &protocols); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range protocols {
		protocol := str(fixture, "protocol")
		s.app.aiClient = &http.Client{Transport: aiRoundTrip(func(r *http.Request) (*http.Response, error) {
			path, response := str(fixture, "path"), object(fixture["response"])
			if r.Method == "GET" {
				path, response = "models", object(fixture["models"])
			} else {
				var payload Object
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil || encode(payload) != encode(fixture["body"]) {
					t.Fatal("native request body", payload, err)
				}
			}
			if r.URL.String() != "https://provider.example/v1/"+path {
				t.Fatal("native path", r.URL)
			}
			for header, value := range object(fixture["headers"]) {
				if r.Header.Get(header) != value {
					t.Fatal("native auth", header)
				}
			}
			return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(encode(response)))}, nil
		})}
		native := object(req("POST", prefix+"channels", Object{"name": protocol, "baseUrl": "https://provider.example/v1", "protocol": protocol, "apiKey": "fixture-secret"}, 201, "")["channel"])
		nativePath := prefix + "channels/" + str(native, "id")
		change := clone(native)
		change["name"] = protocol + " edited"
		native = object(req("PUT", nativePath, change, 200, "")["channel"])
		if native["protocol"] != protocol {
			t.Fatal(native)
		}
		nativeModel := object(req("POST", prefix+"models", Object{"name": "Native", "channelId": native["id"], "modelId": "fixture-model"}, 201, "")["model"])
		if protocol == "gemini" {
			req("POST", prefix+"models", Object{"name": "Invalid path", "channelId": native["id"], "modelId": "models/fixture-model"}, 400, "invalid_ai_model_id")
		}
		if result := object(req("POST", nativePath+"/test", Object{"revision": native["revision"]}, 200, "")["result"]); result["outcome"] != "ok" {
			t.Fatal(result)
		}
		if result := object(req("POST", prefix+"models/"+str(nativeModel, "id")+"/check", Object{"revision": nativeModel["revision"], "channelRevision": native["revision"], "confirmPaid": true}, 200, "")["result"]); result["outcome"] != "ok" {
			t.Fatal(result)
		}
		s.app.aiCycle(context.Background(), true)
		live := object(object(req("GET", prefix+"models/"+str(nativeModel, "id"), nil, 200, "")["model"])["live"])
		if live["outcome"] != "ok" || integer(live, "total") != 1 {
			t.Fatal("native scheduled check", protocol, live)
		}
		req("DELETE", nativePath, Object{"revision": native["revision"]}, 200, "")
	}
	bad = clone(input)
	bad["protocol"] = "unsupported"
	req("POST", prefix+"channels", bad, 400, "invalid_request")
	runAIOptions(t, s)
}

func TestAIManagementSQLite(t *testing.T) {
	s := newTestServer(t)
	if _, err := os.Stat(filepath.Join(s.config.DataDir, "ai-credential.key")); !os.IsNotExist(err) {
		t.Fatal("key created before AI use")
	}
	ordinary := s.createMonitor(t, "push", "", nil)
	runAIManagement(t, s)
	if row, _ := s.app.store.get(context.Background(), "monitor", ordinary); row == nil {
		t.Fatal("existing monitor lost")
	}
}

func TestAICredentialConcurrentFirstUse(t *testing.T) {
	s := newTestServer(t)
	s2 := openTestServer(t, s.config)
	keys := make(chan []byte, 2)
	errors := make(chan error, 2)
	var wg sync.WaitGroup
	for _, app := range []*App{s.app, s2.app} {
		wg.Add(1)
		go func(a *App) {
			defer wg.Done()
			material, err := a.aiKey(context.Background(), true)
			keys <- material
			errors <- err
		}(app)
	}
	wg.Wait()
	close(keys)
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatal(err)
		}
	}
	var first []byte
	for key := range keys {
		if len(key) != 32 {
			t.Fatal("invalid key size")
		}
		if first == nil {
			first = key
		} else if !bytes.Equal(first, key) {
			t.Fatal("concurrent initialization produced distinct keys")
		}
	}
}

func TestAICredentialRestartAndRecovery(t *testing.T) {
	s := newTestServer(t)
	input := Object{"name": "Restart", "baseUrl": "https://provider.example/v1", "protocol": "openai", "apiKey": "fixture-api-key"}
	code, created := s.request(t, "POST", "/api/admin/ai/channels", input, true)
	expectStatus(t, code, 201, created)
	channel := object(created["channel"])
	path := "/api/admin/ai/channels/" + str(channel, "id")
	keyPath := filepath.Join(s.config.DataDir, "ai-credential.key")
	material, err := os.ReadFile(keyPath)
	if err != nil || len(material) != 32 {
		t.Fatal(err)
	}
	snapshot, err := s.app.store.snapshot(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, table := range snapshot {
		for _, row := range table.rows {
			if table.name == "polaris_documents" && row[0] == "ai_channel" {
				found = true
			}
		}
	}
	if !found {
		t.Fatal("database migration omitted AI credentials")
	}
	s.server.Close()
	_ = s.app.Close()
	c := s.config
	c.AdminToken = "different-admin-token"
	s2 := openTestServer(t, c)
	stored, _ := s2.app.store.get(context.Background(), "ai_channel", str(channel, "id"))
	plain, err := s2.app.decryptAICredential(context.Background(), stored)
	if err != nil || plain != "fixture-api-key" {
		t.Fatal("restart or admin password change broke encryption", err)
	}
	wrong := bytes.Repeat([]byte{7}, 32)
	if err = os.WriteFile(keyPath, wrong, 0600); err != nil {
		t.Fatal(err)
	}
	code, result := s2.request(t, "POST", path+"/test", Object{"revision": channel["revision"]}, true)
	expectStatus(t, code, 503, result)
	if result["error"] != "ai_credential_decryption_failed" {
		t.Fatal(result)
	}
	if err = os.WriteFile(keyPath, material, 0600); err != nil {
		t.Fatal(err)
	}
	if plain, err = s2.app.decryptAICredential(context.Background(), stored); err != nil || plain != "fixture-api-key" {
		t.Fatal("restore failed", err)
	}
	if err = os.Remove(keyPath); err != nil {
		t.Fatal(err)
	}
	code, result = s2.request(t, "POST", path+"/test", Object{"revision": channel["revision"]}, true)
	expectStatus(t, code, 503, result)
	if result["error"] != "ai_key_material_unavailable" {
		t.Fatal(result)
	}
	input["name"] = "Must not silently regenerate"
	code, result = s2.request(t, "POST", "/api/admin/ai/channels", input, true)
	expectStatus(t, code, 503, result)
	if _, err = os.Stat(keyPath); !os.IsNotExist(err) {
		t.Fatal("lost key silently regenerated")
	}
	if err = os.WriteFile(keyPath, material, 0600); err != nil {
		t.Fatal(err)
	}
	if err = protectAIKey(keyPath); err != nil {
		t.Fatal(err)
	}
	input["revision"], input["apiKey"] = channel["revision"], "fixture-api-key-replaced"
	code, result = s2.request(t, "PUT", path, input, true)
	expectStatus(t, code, 200, result)
	stored, _ = s2.app.store.get(context.Background(), "ai_channel", str(channel, "id"))
	if plain, err = s2.app.decryptAICredential(context.Background(), stored); err != nil || plain != input["apiKey"] {
		t.Fatal("recovery replacement failed", err)
	}
}

func TestAIManagementPostgres(t *testing.T) {
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
	defer db.Close()
	name := "polaris_ai_" + strings.ReplaceAll(uuid(), "-", "")
	if _, err = db.Exec("CREATE DATABASE " + name); err != nil {
		t.Fatal(err)
	}
	defer db.Exec("DROP DATABASE " + name + " WITH (FORCE)")
	u.Path = "/" + name
	c := DefaultConfig()
	c.DataDir = t.TempDir()
	c.DatabaseURL = u.String()
	c.AdminToken = "fixture-admin"
	c.SetupKey = "fixture-setup"
	s := openTestServer(t, c)
	code, result := s.request(t, "POST", "/api/auth/setup", Object{"credential": c.SetupKey, "username": "fixture-owner", "password": "fixture-owner-secret"}, false)
	expectStatus(t, code, 200, result)
	s.client.Jar, _ = cookiejar.New(nil)
	code, result = s.request(t, "POST", "/api/admin/ai/channels", Object{"name": "No implicit key", "baseUrl": "https://provider.example", "protocol": "openai", "apiKey": "fixture-key"}, true)
	expectStatus(t, code, 503, result)
	if result["error"] != "ai_key_material_unavailable" {
		t.Fatal(result)
	}
	keyPath := filepath.Join(t.TempDir(), "shared.key")
	material := make([]byte, 32)
	_, _ = rand.Read(material)
	if err = os.WriteFile(keyPath, material, 0600); err != nil {
		t.Fatal(err)
	}
	if err = protectAIKey(keyPath); err != nil {
		t.Fatal(err)
	}
	s.app.config.AICredentialKeyFile = keyPath
	runAIManagement(t, s)
	c.AICredentialKeyFile = keyPath
	c.DataDir = t.TempDir()
	s2 := openTestServer(t, c)
	aiMultiInstance(t, s, s2)
}

func TestAIMultiInstanceSQLite(t *testing.T) {
	s := newTestServer(t)
	s2 := openTestServer(t, s.config)
	aiMultiInstance(t, s, s2)
}

func aiMultiInstance(t *testing.T, first, second *testServer) {
	t.Helper()
	input := Object{"name": "Multi instance", "baseUrl": "https://provider.example/v1", "protocol": "openai", "apiKey": "fixture-multi-key"}
	code, result := first.request(t, "POST", "/api/admin/ai/channels", input, true)
	expectStatus(t, code, 201, result)
	channel := object(result["channel"])
	stored, err := second.app.store.get(context.Background(), "ai_channel", str(channel, "id"))
	if err != nil {
		t.Fatal(err)
	}
	plain, err := second.app.decryptAICredential(context.Background(), stored)
	if err != nil || plain != input["apiKey"] {
		t.Fatal("shared key cannot decrypt", err)
	}
	path := "/api/admin/ai/channels/" + str(channel, "id")
	update := clone(input)
	delete(update, "apiKey")
	update["revision"] = channel["revision"]
	var wg sync.WaitGroup
	statuses := make(chan int, 2)
	for _, server := range []*testServer{first, second} {
		wg.Add(1)
		go func(s *testServer) {
			defer wg.Done()
			code, _ := s.request(t, "PUT", path, update, true)
			statuses <- code
		}(server)
	}
	wg.Wait()
	close(statuses)
	success, conflict := 0, 0
	for code := range statuses {
		if code == 200 {
			success++
		}
		if code == 409 {
			conflict++
		}
	}
	if success != 1 || conflict != 1 {
		t.Fatal("cross-instance CAS", success, conflict)
	}
	code, result = second.request(t, "GET", path, nil, true)
	expectStatus(t, code, 200, result)
	channel = object(result["channel"])
	statuses = make(chan int, 2)
	wg.Add(2)
	go func() {
		defer wg.Done()
		code, _ := first.request(t, "DELETE", path, Object{"revision": channel["revision"]}, true)
		statuses <- code
	}()
	go func() {
		defer wg.Done()
		code, _ := second.request(t, "POST", "/api/admin/ai/models", Object{"channelId": channel["id"], "name": "Concurrent model", "modelId": "concurrent-model"}, true)
		statuses <- code
	}()
	wg.Wait()
	close(statuses)
	for code := range statuses {
		if code != 200 && code != 201 && code != 404 && code != 409 {
			t.Fatal("unexpected concurrent cascade status", code)
		}
	}
	row, err := second.app.store.get(context.Background(), "ai_channel", str(channel, "id"))
	if err != nil {
		t.Fatal(err)
	}
	if row != nil {
		code, result = second.request(t, "DELETE", path, Object{"revision": row["revision"]}, true)
		expectStatus(t, code, 200, result)
	}
	models, err := second.app.store.list(context.Background(), "ai_model")
	if err != nil || len(models) != 0 {
		t.Fatal("dangling model after concurrent deletion", err, models)
	}
}

func TestAIURLPolicy(t *testing.T) {
	data, err := os.ReadFile("../../../../test/fixtures/ai-url-policy.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixtures []struct {
		URL   string `json:"url"`
		Valid bool   `json:"valid"`
	}
	if err = json.Unmarshal(data, &fixtures); err != nil {
		t.Fatal(err)
	}
	for _, fixture := range fixtures {
		_, err := aiBaseURL(fixture.URL)
		if (err == nil) != fixture.Valid {
			t.Errorf("url %s: %v", fixture.URL, err)
		}
	}
}
