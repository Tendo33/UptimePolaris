package polaris

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/coreos/go-oidc/v3/oidc"
	"github.com/go-jose/go-jose/v4"
)

func TestExternalAuthConfiguration(t *testing.T) {
	valid := []ExternalAuthConfig{
		{}, {Mode: "disabled"},
		{Mode: "trusted-header", TrustedProxies: "127.0.0.1/32,::1/128"},
		{Mode: "cloudflare-access", TeamDomain: "https://polaris.cloudflareaccess.com/", Audience: "app-aud", AllowedIdentities: "owner@example.com"},
	}
	for _, config := range valid {
		if _, err := newExternalAuthenticator(config); err != nil {
			t.Fatalf("%+v: %v", config, err)
		}
	}
	invalid := []ExternalAuthConfig{
		{Mode: "proxy"},
		{Mode: "trusted-header"},
		{Mode: "trusted-header", TrustedProxies: "127.0.0.1"},
		{Mode: "trusted-header", TrustedProxies: "0.0.0.0/0"},
		{Mode: "trusted-header", TrustedProxies: "::/0"},
		{Mode: "trusted-header", TrustedProxies: "127.0.0.1/32", Header: "Authorization"},
		{Mode: "trusted-header", TrustedProxies: "127.0.0.1/32", Header: "X-User\r\n"},
		{Mode: "trusted-header", TrustedProxies: "127.0.0.1/32", AllowedIdentities: "owner,"},
		{Mode: "cloudflare-access", TeamDomain: "http://polaris.cloudflareaccess.com", Audience: "app"},
		{Mode: "cloudflare-access", TeamDomain: "https://polaris.cloudflareaccess.com.evil.test", Audience: "app"},
		{Mode: "cloudflare-access", TeamDomain: "https://polaris.cloudflareaccess.com/path", Audience: "app"},
		{Mode: "cloudflare-access", TeamDomain: "https://polaris.cloudflareaccess.com:443", Audience: "app"},
		{Mode: "cloudflare-access", TeamDomain: "https://polaris.cloudflareaccess.com?x=1", Audience: "app"},
		{Mode: "cloudflare-access", TeamDomain: "https://polaris.cloudflareaccess.com"},
	}
	for _, config := range invalid {
		if _, err := newExternalAuthenticator(config); err == nil {
			t.Fatalf("accepted %+v", config)
		}
	}
}

func TestTrustedHeaderIdentity(t *testing.T) {
	auth, err := newExternalAuthenticator(ExternalAuthConfig{Mode: "trusted-header", Header: "X-Forwarded-User", TrustedProxies: "127.0.0.1/32,::1/128", AllowedIdentities: "owner"})
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, peer string
		values     []string
		allowed    bool
	}{
		{"trusted IPv4", "127.0.0.1:1234", []string{"owner"}, true},
		{"trusted IPv6", "[::1]:1234", []string{"owner"}, true},
		{"mapped IPv4", "[::ffff:127.0.0.1]:1234", []string{"owner"}, true},
		{"direct spoof", "203.0.113.7:1234", []string{"owner"}, false},
		{"missing", "127.0.0.1:1234", nil, false},
		{"multiple", "127.0.0.1:1234", []string{"owner", "attacker"}, false},
		{"combined", "127.0.0.1:1234", []string{"owner,attacker"}, false},
		{"not allowed", "127.0.0.1:1234", []string{"other"}, false},
		{"case differs", "127.0.0.1:1234", []string{"Owner"}, false},
		{"control", "127.0.0.1:1234", []string{"owner\n"}, false},
		{"oversized", "127.0.0.1:1234", []string{strings.Repeat("a", 321)}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://polaris.test/api/monitors", nil)
			r.RemoteAddr = tc.peer
			r.Header["X-Forwarded-User"] = tc.values
			r.Header.Set("X-Forwarded-For", "127.0.0.1")
			r.Header.Set("Forwarded", "for=127.0.0.1")
			user := auth.user(r)
			if (user != nil) != tc.allowed {
				t.Fatalf("unexpected identity: %v", user)
			}
			if user != nil && (!strings.HasPrefix(str(user, "id"), "external:") || str(user, "auth_provider") != "trusted-header") {
				t.Fatal(user)
			}
		})
	}
}

func TestExternalAuthSessionAndFallback(t *testing.T) {
	s := newTestServer(t)
	auth, err := newExternalAuthenticator(ExternalAuthConfig{Mode: "trusted-header", TrustedProxies: "127.0.0.1/32,::1/128", AllowedIdentities: "fixture-owner"})
	if err != nil {
		t.Fatal(err)
	}
	s.app.externalAuth = auth
	request := func(method, path string, value any, identity, origin string) (int, Object, *http.Response) {
		t.Helper()
		var body io.Reader
		if value != nil {
			body = strings.NewReader(encode(value))
		}
		r, err := http.NewRequest(method, s.server.URL+path, body)
		if err != nil {
			t.Fatal(err)
		}
		if identity != "" {
			r.Header.Set("Remote-User", identity)
		}
		if origin != "" {
			r.Header.Set("Origin", origin)
		}
		response, err := s.client.Do(r)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var result Object
		if err := json.NewDecoder(response.Body).Decode(&result); err != nil {
			t.Fatal(err)
		}
		return response.StatusCode, result, response
	}
	code, session, response := request("GET", "/api/auth/session", nil, "fixture-owner", "")
	expectStatus(t, code, 200, session)
	if session["authenticated"] != true || session["authentication"] != "trusted-header" || len(response.Cookies()) != 0 {
		t.Fatal(session, response.Cookies())
	}
	id := str(object(session["user"]), "id")
	users, _ := s.app.store.list(context.Background(), "user")
	if len(users) != 1 || str(users[0], "id") == id {
		t.Fatal("external identity linked to local account", users)
	}
	code, result, _ := request("GET", "/api/monitors", nil, "fixture-owner", "")
	expectStatus(t, code, 200, result)
	code, result, _ = request("GET", "/api/monitors", nil, "", "")
	expectStatus(t, code, 401, result)
	code, result, _ = request("POST", "/api/groups", Object{"name": "cross-origin"}, "fixture-owner", "https://evil.test")
	expectStatus(t, code, 403, result)
	code, result, _ = request("POST", "/api/groups", Object{"name": "external-admin"}, "fixture-owner", s.server.URL)
	expectStatus(t, code, 201, result)
	code, result, _ = request("POST", "/api/auth/account", Object{"username": "takeover", "current": "fixture-owner-secret"}, "fixture-owner", "")
	expectStatus(t, code, 403, result)
	if result["error"] != "external_account_managed" {
		t.Fatal(result)
	}
	code, result, _ = request("GET", "/api/auth/avatar", nil, "fixture-owner", "")
	expectStatus(t, code, 200, result)
	code, result, _ = request("POST", "/api/auth/logout", nil, "fixture-owner", "")
	expectStatus(t, code, 200, result)
	_, session, _ = request("GET", "/api/auth/session", nil, "fixture-owner", "")
	if session["authenticated"] != false || object(session["externalAuth"])["mode"] != "trusted-header" {
		t.Fatal(session)
	}
	code, result, _ = request("POST", "/api/auth/external", nil, "fixture-owner", "https://evil.test")
	expectStatus(t, code, 403, result)
	code, result, _ = request("POST", "/api/auth/external", nil, "other", "")
	expectStatus(t, code, 401, result)
	code, result, _ = request("POST", "/api/auth/external", nil, "fixture-owner", "")
	expectStatus(t, code, 200, result)
	_, session, _ = request("GET", "/api/auth/session", nil, "fixture-owner", "")
	if session["authenticated"] != true || str(object(session["user"]), "id") != id {
		t.Fatal(session)
	}
	request("POST", "/api/auth/logout", nil, "fixture-owner", "")
	code, result, _ = request("POST", "/api/auth/login", Object{"username": "fixture-owner", "password": "fixture-owner-secret"}, "other", "")
	expectStatus(t, code, 200, result)
	_, session, _ = request("GET", "/api/auth/session", nil, "fixture-owner", "")
	if session["authentication"] != "local" || str(object(session["user"]), "id") == id {
		t.Fatal(session)
	}
	request("POST", "/api/auth/logout", nil, "", "")
	code, result = s.request(t, "GET", "/api/monitors", nil, true)
	expectStatus(t, code, 200, result)
}

func TestExternalAuthDisabledAndSetup(t *testing.T) {
	s := newUninitializedTestServer(t)
	s.app.externalAuth, _ = newExternalAuthenticator(ExternalAuthConfig{Mode: "trusted-header", TrustedProxies: "127.0.0.1/32"})
	r := httptest.NewRequest("GET", "/api/auth/session", nil)
	r.RemoteAddr = "127.0.0.1:1234"
	r.Header.Set("Remote-User", "owner")
	w := httptest.NewRecorder()
	s.app.Handler().ServeHTTP(w, r)
	var result Object
	json.Unmarshal(w.Body.Bytes(), &result)
	if result["authenticated"] != false || result["needsSetup"] != true {
		t.Fatal(result)
	}
	s.app.externalAuth = nil
	if s.app.user(r) != nil {
		t.Fatal("disabled authentication accepted a header")
	}
}

func TestCloudflareAccessJWT(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	otherKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var fetches atomic.Int32
	var rotated atomic.Bool
	var unavailable atomic.Bool
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fetches.Add(1)
		if r.URL.Path != "/cdn-cgi/access/certs" {
			t.Errorf("unexpected key path %s", r.URL.Path)
		}
		if unavailable.Load() {
			w.WriteHeader(503)
			return
		}
		public := &key.PublicKey
		kid := "first"
		if rotated.Load() {
			public, kid = &otherKey.PublicKey, "second"
		}
		json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{{Key: public, KeyID: kid, Algorithm: "RS256", Use: "sig"}}})
	}))
	defer server.Close()
	auth, err := newExternalAuthenticator(ExternalAuthConfig{Mode: "cloudflare-access", TeamDomain: "https://polaris.cloudflareaccess.com", Audience: "app-aud", AllowedIdentities: "OWNER@example.com"})
	if err != nil {
		t.Fatal(err)
	}
	client := server.Client()
	transport := &accessKeysTransport{base: client.Transport}
	client.Transport = transport
	client.Timeout = 5 * time.Second
	keys := oidc.NewRemoteKeySet(oidc.ClientContext(context.Background(), client), server.URL+"/cdn-cgi/access/certs")
	auth.verifier = oidc.NewVerifier(auth.issuer, keys, &oidc.Config{ClientID: "app-aud", SupportedSigningAlgs: []string{"RS256"}})
	sign := func(claims Object, signingKey *rsa.PrivateKey, kid string) string {
		t.Helper()
		signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: signingKey}, (&jose.SignerOptions{}).WithHeader("kid", kid))
		if err != nil {
			t.Fatal(err)
		}
		signed, err := signer.Sign([]byte(encode(claims)))
		if err != nil {
			t.Fatal(err)
		}
		raw, err := signed.CompactSerialize()
		if err != nil {
			t.Fatal(err)
		}
		return raw
	}
	base := Object{"iss": auth.issuer, "aud": []string{"app-aud"}, "exp": time.Now().Add(time.Hour).Unix(), "iat": time.Now().Add(-time.Minute).Unix(), "nbf": time.Now().Add(-time.Minute).Unix(), "sub": "stable-subject", "email": "owner@example.com", "type": "app"}
	read := func(raw string) Object {
		r := httptest.NewRequest("GET", "/api/monitors", nil)
		r.Header.Set("Cf-Access-Jwt-Assertion", raw)
		return auth.user(r)
	}
	raw := sign(base, key, "first")
	user := read(raw)
	if user == nil || str(user, "username") != "owner@example.com" {
		t.Fatal(user)
	}
	if read(raw) == nil || fetches.Load() != 1 {
		t.Fatal("keys not cached", fetches.Load())
	}
	for _, tc := range []struct {
		name, field string
		value       any
	}{
		{"issuer", "iss", "https://other.cloudflareaccess.com"},
		{"audience", "aud", []string{"other-app"}},
		{"expired", "exp", time.Now().Add(-time.Minute).Unix()},
		{"missing expiry", "exp", nil},
		{"future nbf", "nbf", time.Now().Add(2 * time.Minute).Unix()},
		{"future iat", "iat", time.Now().Add(2 * time.Minute).Unix()},
		{"service token", "type", "service"},
		{"empty subject", "sub", ""},
		{"not allowed", "email", "other@example.com"},
		{"empty email", "email", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			claims := clone(base)
			claims[tc.field] = tc.value
			if read(sign(claims, key, "first")) != nil {
				t.Fatal("invalid token accepted")
			}
		})
	}
	if read(sign(base, otherKey, "first")) != nil {
		t.Fatal("wrong signature accepted")
	}
	if fetches.Load() != 1 {
		t.Fatal("untrusted tokens bypassed key refresh cooldown")
	}
	if read("eyJhbGciOiJub25lIn0."+strings.Repeat("A", 200)+".") != nil {
		t.Fatal("unsigned token accepted")
	}
	r := httptest.NewRequest("GET", "/api/monitors", nil)
	r.Header["Cf-Access-Jwt-Assertion"] = []string{raw, raw}
	if auth.user(r) != nil {
		t.Fatal("multiple JWT headers accepted")
	}
	rotated.Store(true)
	transport.mu.Lock()
	transport.nextFetch = time.Time{}
	transport.mu.Unlock()
	if read(sign(base, otherKey, "second")) == nil || fetches.Load() != 2 {
		t.Fatal("rotated key unavailable")
	}
	unavailable.Store(true)
	transport.mu.Lock()
	transport.nextFetch = time.Time{}
	transport.mu.Unlock()
	if read(sign(base, key, "unknown")) != nil {
		t.Fatal("key outage accepted unknown key")
	}
}
