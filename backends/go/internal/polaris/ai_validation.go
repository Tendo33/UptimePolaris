package polaris

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

var aiDotSegment = regexp.MustCompile(`(?i)(^|/)(\.|%2e){1,2}(/|$)`)
var aiNumericHost = regexp.MustCompile(`^(?:[0-9.]+|0x[0-9a-f]+)$`)
var aiGeminiModelID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]*$`)

func validAIProtocol(protocol string) bool {
	return contains([]string{"openai", "openai_responses", "anthropic", "gemini"}, protocol)
}

func validAIModelID(protocol, model string) bool {
	return strings.TrimSpace(model) != "" && (protocol != "gemini" || aiGeminiModelID.MatchString(model))
}

func aiAllowedIP(ip netip.Addr) bool {
	ip = ip.Unmap()
	if ip == netip.MustParseAddr("100.100.100.200") || ip == netip.MustParseAddr("fd00:ec2::254") {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() {
		return true
	}
	if !ip.IsGlobalUnicast() || ip.IsLinkLocalUnicast() {
		return false
	}
	for _, block := range []string{"0.0.0.0/8", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4"} {
		if netip.MustParsePrefix(block).Contains(ip) {
			return false
		}
	}
	return ip.Is4() || netip.MustParsePrefix("2000::/3").Contains(ip) && !netip.MustParsePrefix("2001:db8::/32").Contains(ip)
}

func aiBaseURL(value string) (*url.URL, error) {
	bad := failure("invalid_ai_url", 400)
	if value == "" || len(value) > 2048 || strings.ContainsAny(value, "\\?# \t\r\n") {
		return nil, bad
	}
	for _, ch := range value {
		if ch < 33 || ch == 127 {
			return nil, bad
		}
	}
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" && u.Scheme != "http" || u.Hostname() == "" || u.User != nil || u.Opaque != "" || u.ForceQuery || aiDotSegment.MatchString(u.EscapedPath()) {
		return nil, bad
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if strings.Contains(host, "%") || contains([]string{"metadata.google.internal", "metadata.goog", "metadata.internal", "instance-data.ec2.internal"}, host) {
		return nil, bad
	}
	if ip, e := netip.ParseAddr(host); e == nil {
		if !aiAllowedIP(ip) {
			return nil, bad
		}
	} else {
		if strings.Contains(host, ":") || aiNumericHost.MatchString(host) {
			return nil, bad
		}
		for _, suffix := range []string{".test", ".invalid"} {
			if strings.HasSuffix(host, suffix) {
				return nil, bad
			}
		}
		for _, ch := range host {
			if !(ch >= 'a' && ch <= 'z' || ch >= '0' && ch <= '9' || ch == '-' || ch == '.') {
				return nil, bad
			}
		}
	}
	if port := u.Port(); port != "" {
		p, err := net.LookupPort("tcp", port)
		if err != nil || p < 1 || p > 65535 {
			return nil, bad
		}
	}
	return u, nil
}

func aiText(value any, limit int) (string, error) {
	v, ok := value.(string)
	if !ok || !utf8.ValidString(v) {
		return "", failure("invalid_request", 400)
	}
	for _, ch := range v {
		if ch < 32 || ch == 127 {
			return "", failure("invalid_request", 400)
		}
	}
	v = strings.TrimSpace(v)
	if v == "" || utf8.RuneCountInString(v) > limit {
		return "", failure("invalid_request", 400)
	}
	return v, nil
}

func aiChannelInput(b Object, create bool) (Object, error) {
	name, err := aiText(b["name"], 120)
	if err != nil {
		return nil, err
	}
	if _, err = aiBaseURL(str(b, "baseUrl")); err != nil {
		return nil, err
	}
	if !validAIProtocol(str(b, "protocol")) {
		return nil, failure("invalid_request", 400)
	}
	input := Object{"name": name, "baseUrl": b["baseUrl"], "protocol": b["protocol"]}
	value, present := b["apiKey"]
	if !present && create {
		return nil, failure("api_key_required", 400)
	}
	if present {
		key, ok := value.(string)
		if !ok || len(key) < 1 || len(key) > 4096 {
			return nil, failure("invalid_request", 400)
		}
		for _, ch := range key {
			if ch < 33 || ch > 126 {
				return nil, failure("invalid_request", 400)
			}
		}
		input["apiKey"] = key
	}
	if raw, present := b["headers"]; present {
		headers, err := aiHeaders(raw)
		if err != nil {
			return nil, err
		}
		input["headers"] = headers
	}
	if raw, present := b["notificationChannelIds"]; present {
		if !validNotificationIDs(raw) {
			return nil, failure("invalid_request", 400)
		}
		input["notificationChannelIds"] = raw
	}
	if raw, present := b["notificationEnabled"]; present {
		if _, ok := raw.(bool); !ok {
			return nil, failure("invalid_request", 400)
		}
		input["notificationEnabled"] = raw
	}
	return input, nil
}

func aiModelInput(b Object, create bool) (Object, error) {
	input := Object{}
	for field, max := range map[string]int{"channelId": 64, "name": 120, "modelId": 200} {
		value, err := aiText(b[field], max)
		if err != nil {
			return nil, err
		}
		input[field] = value
	}
	for field, def := range (Object{"intervalSec": 300, "timeoutMs": 30000, "enabled": true, "isPublic": false}) {
		value, present := b[field]
		if !present && create {
			value = def
		}
		if field == "enabled" || field == "isPublic" {
			if _, ok := value.(bool); !ok {
				return nil, failure("invalid_request", 400)
			}
		} else {
			n := number(value)
			if n != float64(int64(n)) || n == 0 {
				return nil, failure("invalid_request", 400)
			}
			if _, ok := value.(string); ok {
				return nil, failure("invalid_request", 400)
			}
		}
		input[field] = value
	}
	if raw, present := b["request"]; present {
		request, err := aiRequest(raw)
		if err != nil {
			return nil, err
		}
		input["request"] = request
	} else if create {
		input["request"] = defaultAIRequest()
	}
	interval, timeout := integer(input, "intervalSec"), integer(input, "timeoutMs")
	if interval < 60 || interval > 86400 || timeout < 1000 || timeout > 60000 || timeout >= interval*1000 {
		return nil, failure("invalid_request", 400)
	}

	return input, nil
}

func aiHTTPClient() *http.Client {
	transport := &http.Transport{TLSHandshakeTimeout: 10 * time.Second, ResponseHeaderTimeout: 60 * time.Second, DisableKeepAlives: true}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, err
		}
		ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil || len(ips) == 0 {
			return nil, errors.New("ai_address_unavailable")
		}
		for _, ip := range ips {
			if !aiAllowedIP(ip) {
				return nil, errors.New("ai_address_refused")
			}
		}
		var last error
		for _, ip := range ips {
			conn, err := (&net.Dialer{}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return conn, nil
			}
			last = err
		}
		return nil, last
	}
	return &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
