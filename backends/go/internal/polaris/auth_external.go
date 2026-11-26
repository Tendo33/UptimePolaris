package polaris

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/mail"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/coreos/go-oidc/v3/oidc"
)

type ExternalAuthConfig struct {
	Mode              string
	Header            string
	TrustedProxies    string
	TeamDomain        string
	Audience          string
	AllowedIdentities string
}

type externalAuthenticator struct {
	mode     string
	header   string
	issuer   string
	proxies  []netip.Prefix
	allowed  map[string]bool
	verifier *oidc.IDTokenVerifier
}

type requestIdentityKey struct{}
type requestIdentity struct {
	once sync.Once
	user Object
}

const externalLogoutCookie = "polaris_external_logout"

var identityHeaderPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9-]{0,63}$`)
var accessTeamPattern = regexp.MustCompile(`^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$`)

func newExternalAuthenticator(c ExternalAuthConfig) (*externalAuthenticator, error) {
	if c.Mode == "" || c.Mode == "disabled" {
		return nil, nil
	}
	a := &externalAuthenticator{mode: c.Mode, allowed: map[string]bool{}}
	if c.Mode != "trusted-header" && c.Mode != "cloudflare-access" {
		return nil, fmt.Errorf("POLARIS_AUTH_MODE must be disabled, trusted-header or cloudflare-access")
	}
	if strings.TrimSpace(c.AllowedIdentities) != "" {
		for _, value := range strings.Split(c.AllowedIdentities, ",") {
			identity := strings.TrimSpace(value)
			if !validExternalIdentity(identity) {
				return nil, fmt.Errorf("POLARIS_AUTH_ALLOWED_IDENTITIES must contain nonempty identities")
			}
			if c.Mode == "cloudflare-access" {
				identity = strings.ToLower(identity)
			}
			a.allowed[identity] = true
		}
	}
	if c.Mode == "trusted-header" {
		a.header = c.Header
		if a.header == "" {
			a.header = "Remote-User"
		}
		if !identityHeaderPattern.MatchString(a.header) {
			return nil, fmt.Errorf("POLARIS_AUTH_HEADER must be an HTTP identity header name")
		}
		switch strings.ToLower(a.header) {
		case "host", "cookie", "authorization", "forwarded", "connection", "content-length", "x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "cf-access-jwt-assertion":
			return nil, fmt.Errorf("POLARIS_AUTH_HEADER cannot use a transport or credential header")
		}
		var err error
		a.proxies, err = parseTrustedProxies(c.TrustedProxies)
		if err != nil || len(a.proxies) == 0 {
			return nil, fmt.Errorf("POLARIS_AUTH_TRUSTED_PROXIES requires explicit proxy CIDRs")
		}
		for _, prefix := range a.proxies {
			if prefix.Bits() == 0 {
				return nil, fmt.Errorf("POLARIS_AUTH_TRUSTED_PROXIES cannot trust every address")
			}
		}
		return a, nil
	}
	team, err := url.Parse(c.TeamDomain)
	if err != nil || team.Scheme != "https" || !accessTeamPattern.MatchString(team.Host) || team.User != nil || team.RawQuery != "" || team.Fragment != "" || team.ForceQuery || (team.Path != "" && team.Path != "/") {
		return nil, fmt.Errorf("POLARIS_AUTH_CF_TEAM_DOMAIN must be https://<team>.cloudflareaccess.com")
	}
	if c.Audience == "" || c.Audience != strings.TrimSpace(c.Audience) || len(c.Audience) > 512 || strings.ContainsAny(c.Audience, ", \t\r\n") {
		return nil, fmt.Errorf("POLARIS_AUTH_CF_AUDIENCE requires one application AUD tag")
	}
	a.issuer = "https://" + team.Host
	client := &http.Client{
		Timeout:       5 * time.Second,
		Transport:     &accessKeysTransport{base: http.DefaultTransport},
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	keys := oidc.NewRemoteKeySet(oidc.ClientContext(context.Background(), client), a.issuer+"/cdn-cgi/access/certs")
	a.verifier = oidc.NewVerifier(a.issuer, keys, &oidc.Config{ClientID: c.Audience, SupportedSigningAlgs: []string{"RS256"}})
	return a, nil
}

func validExternalIdentity(value string) bool {
	return value != "" && len(value) <= 320 && utf8.ValidString(value) && strings.TrimSpace(value) == value && !strings.Contains(value, ",") && strings.IndexFunc(value, unicode.IsControl) < 0
}

func singleIdentityHeader(r *http.Request, name string, limit int) string {
	values := r.Header.Values(name)
	if len(values) != 1 || len(values[0]) > limit {
		return ""
	}
	return values[0]
}

func (a *externalAuthenticator) user(r *http.Request) Object {
	if a == nil {
		return nil
	}
	var identity, subject string
	if a.mode == "trusted-header" {
		host, _, err := net.SplitHostPort(r.RemoteAddr)
		if err != nil {
			return nil
		}
		peer, err := netip.ParseAddr(host)
		if err != nil || peer.Zone() != "" {
			return nil
		}
		trusted := false
		for _, prefix := range a.proxies {
			trusted = trusted || prefix.Contains(peer.Unmap())
		}
		if !trusted {
			return nil
		}
		identity = singleIdentityHeader(r, a.header, 320)
		subject = strings.ToLower(a.header) + "\x00" + identity
	} else {
		raw := singleIdentityHeader(r, "Cf-Access-Jwt-Assertion", 16<<10)
		if raw == "" {
			return nil
		}
		token, err := a.verifier.Verify(r.Context(), raw)
		if err != nil || token.Subject == "" || len(token.Subject) > 512 || token.IssuedAt.After(time.Now().Add(30*time.Second)) {
			return nil
		}
		var claims struct {
			Email     string `json:"email"`
			Type      string `json:"type"`
			NotBefore int64  `json:"nbf"`
		}
		if token.Claims(&claims) != nil || claims.Type != "app" || claims.NotBefore > time.Now().Add(30*time.Second).Unix() {
			return nil
		}
		address, err := mail.ParseAddress(claims.Email)
		if err != nil || address.Address != claims.Email {
			return nil
		}
		identity = strings.ToLower(claims.Email)
		subject = a.issuer + "\x00" + token.Subject
	}
	if !validExternalIdentity(identity) || len(a.allowed) > 0 && !a.allowed[identity] {
		return nil
	}
	return Object{"id": "external:" + digest(a.mode+"\x00"+subject), "username": identity, "auth_provider": a.mode}
}

func (a *App) externalUser(r *http.Request) Object {
	select {
	case <-a.setupReady:
	default:
		return nil
	}
	if cookie, err := r.Cookie(externalLogoutCookie); err == nil && cookie.Value == "1" {
		return nil
	}
	if state, ok := r.Context().Value(requestIdentityKey{}).(*requestIdentity); ok {
		state.once.Do(func() { state.user = a.externalAuth.user(r) })
		return state.user
	}
	return a.externalAuth.user(r)
}

func (a *App) setExternalLogout(w http.ResponseWriter, r *http.Request, suppressed bool) {
	cookie := &http.Cookie{Name: externalLogoutCookie, Path: "/", HttpOnly: true, SameSite: http.SameSiteLaxMode, Secure: r.TLS != nil || a.config.TrustProxy && strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")}
	if suppressed {
		cookie.Value = "1"
	} else {
		cookie.MaxAge = -1
	}
	http.SetCookie(w, cookie)
}

type accessKeysTransport struct {
	base      http.RoundTripper
	mu        sync.Mutex
	nextFetch time.Time
}

func (t *accessKeysTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	t.mu.Lock()
	if time.Now().Before(t.nextFetch) {
		t.mu.Unlock()
		return nil, fmt.Errorf("Access key refresh cooling down")
	}
	t.nextFetch = time.Now().Add(10 * time.Second)
	t.mu.Unlock()
	response, err := t.base.RoundTrip(r)
	if err != nil {
		return nil, err
	}
	response.Body = &limitedKeysBody{Reader: io.LimitReader(response.Body, (1<<20)+1), Closer: response.Body}
	return response, nil
}

type limitedKeysBody struct {
	io.Reader
	io.Closer
}
