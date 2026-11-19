package polaris

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"
)

type subscriptionFetchError struct {
	code       string
	retryAfter int64
}

func (e *subscriptionFetchError) Error() string { return e.code }

func subscriptionURL(value string) (*url.URL, error) {
	u, err := url.Parse(value)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.Fragment != "" || u.Port() != "" && u.Port() != "443" {
		return nil, subscriptionError("source_blocked")
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if !strings.Contains(host, ".") || net.ParseIP(host) != nil {
		return nil, subscriptionError("source_blocked")
	}
	for _, suffix := range []string{".localhost", ".local", ".internal", ".home", ".arpa", ".invalid", ".test", ".example"} {
		if strings.HasSuffix(host, suffix) {
			return nil, subscriptionError("source_blocked")
		}
	}
	return u, nil
}

func publicSubscriptionIP(address netip.Addr) bool {
	address = address.Unmap()
	if !address.IsGlobalUnicast() || address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast() {
		return false
	}
	for _, block := range []string{"0.0.0.0/8", "100.64.0.0/10", "192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "240.0.0.0/4", "2001:db8::/32"} {
		if netip.MustParsePrefix(block).Contains(address) {
			return false
		}
	}
	return true
}

func subscriptionSourcePage(config Object) any {
	descriptor := object(config["descriptor"])
	page := object(descriptor["sourcePage"])
	if page == nil {
		return nil
	}
	parameters := object(config["parameters"])
	path := subscriptionInputToken.ReplaceAllStringFunc(str(page, "path"), func(token string) string { return url.PathEscape(fmt.Sprint(parameters[token[1:len(token)-1]])) })
	base := parameters[str(page, "baseUrlInput")]
	if base == nil {
		base = object(object(descriptor["inputs"])[str(page, "baseUrlInput")])["default"]
	}
	address, err := subscriptionURL(strings.TrimSuffix(fmt.Sprint(base), "/") + path)
	if err != nil {
		return nil
	}
	return address.String()
}

func newSubscriptionClient() *http.Client {
	transport := &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12}, MaxIdleConns: 16, MaxIdleConnsPerHost: 2, IdleConnTimeout: 60 * time.Second, ResponseHeaderTimeout: 10 * time.Second}
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, subscriptionError("source_blocked")
		}
		addresses, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
		if err != nil || len(addresses) == 0 {
			return nil, subscriptionError("fetch_failed")
		}
		for _, ip := range addresses {
			if !publicSubscriptionIP(ip) {
				return nil, subscriptionError("source_blocked")
			}
		}
		var last error
		for _, ip := range addresses {
			connection, err := (&net.Dialer{Timeout: 10 * time.Second}).DialContext(ctx, network, net.JoinHostPort(ip.String(), port))
			if err == nil {
				return connection, nil
			}
			last = err
		}
		return nil, last
	}
	return &http.Client{Transport: transport, Timeout: 10 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}

func subParameters(descriptor, supplied Object) (Object, error) {
	result := Object{}
	inputs := object(descriptor["inputs"])
	for key := range supplied {
		if inputs[key] == nil {
			return nil, subscriptionError("parameters_invalid")
		}
	}
	for key, raw := range inputs {
		spec := object(raw)
		value, exists := supplied[key]
		if !exists || value == nil {
			value = spec["default"]
		}
		if value == nil || value == "" {
			if boolean(spec["required"]) {
				return nil, subscriptionError("parameters_invalid")
			}
			continue
		}
		switch spec["type"] {
		case "number":
			if _, ok := value.(float64); !ok {
				return nil, subscriptionError("parameters_invalid")
			}
		case "boolean":
			if _, ok := value.(bool); !ok {
				return nil, subscriptionError("parameters_invalid")
			}
		default:
			text, ok := value.(string)
			if !ok || len(text) > 8192 || strings.ContainsAny(text, "\x00\r\n") {
				return nil, subscriptionError("parameters_invalid")
			}
		}
		if spec["type"] == "enum" && !contains(stringsOf(spec["options"]), fmt.Sprint(value)) {
			return nil, subscriptionError("parameters_invalid")
		}
		if spec["type"] == "url" {
			parsed, err := subscriptionURL(fmt.Sprint(value))
			if err != nil || parsed.RawQuery != "" {
				return nil, subscriptionError("parameters_invalid")
			}
		}
		result[key] = value
	}
	return result, nil
}

func subSubstitute(value string, parameters Object, path bool) string {
	return subscriptionInputToken.ReplaceAllStringFunc(value, func(token string) string {
		key := token[1 : len(token)-1]
		replacement := fmt.Sprint(parameters[key])
		if parameters[key] == nil {
			replacement = ""
		}
		if path {
			return url.PathEscape(replacement)
		}
		return replacement
	})
}
func subBody(value any, parameters Object) any {
	switch v := value.(type) {
	case string:
		if match := subscriptionInputToken.FindStringSubmatch(v); len(match) > 0 && match[0] == v {
			return parameters[match[1]]
		}
		return subSubstitute(v, parameters, false)
	case []any:
		values := make([]any, len(v))
		for i, child := range v {
			values[i] = subBody(child, parameters)
		}
		return values
	case map[string]any:
		result := Object{}
		for key, child := range v {
			result[key] = subBody(child, parameters)
		}
		return result
	case Object:
		result := Object{}
		for key, child := range v {
			result[key] = subBody(child, parameters)
		}
		return result
	default:
		return value
	}
}

func (a *App) subFetchJSON(ctx context.Context, target *url.URL, method string, headers http.Header, body any, remaining *int, maxBytes int64) (Object, error) {
	client := a.subscriptionClient
	if client == nil {
		return nil, subscriptionError("fetch_failed")
	}
	for redirect := 0; redirect <= 3; redirect++ {
		if _, err := subscriptionURL(target.String()); err != nil {
			return nil, err
		}
		if *remaining <= 0 {
			return nil, subscriptionError("limit_exceeded")
		}
		*remaining--
		var reader io.Reader
		if body != nil {
			reader = bytes.NewReader([]byte(encode(body)))
		}
		request, err := http.NewRequestWithContext(ctx, method, target.String(), reader)
		if err != nil {
			return nil, subscriptionError("fetch_failed")
		}
		request.Header = headers.Clone()
		response, err := client.Do(request)
		if err != nil {
			return nil, subscriptionError("fetch_failed")
		}
		if contains([]string{"301", "302", "303", "307", "308"}, strconv.Itoa(response.StatusCode)) {
			response.Body.Close()
			next, err := target.Parse(response.Header.Get("Location"))
			if err != nil || redirect == 3 {
				return nil, subscriptionError("redirect_invalid")
			}
			if next.Host != target.Host {
				if body != nil {
					return nil, subscriptionError("redirect_invalid")
				}
				headers = http.Header{"Accept": []string{"application/json"}}
			}
			if response.StatusCode == 303 || (response.StatusCode == 301 || response.StatusCode == 302) && method == "POST" {
				method, body = "GET", nil
			}
			target = next
			continue
		}
		if response.StatusCode == 304 {
			response.Body.Close()
			return Object{"notModified": true}, nil
		}
		if response.StatusCode < 200 || response.StatusCode > 299 {
			response.Body.Close()
			code := "fetch_failed"
			if response.StatusCode == 429 {
				code = "rate_limited"
			} else if response.StatusCode == 401 || response.StatusCode == 403 {
				code = "authentication_failed"
			}
			retryAfter := int64(0)
			if response.StatusCode == 429 || response.StatusCode == 503 {
				value := response.Header.Get("Retry-After")
				if seconds, err := strconv.ParseInt(value, 10, 64); err == nil {
					retryAfter = seconds
				} else if stamp, err := http.ParseTime(value); err == nil {
					retryAfter = stamp.Unix() - time.Now().Unix()
				}
			}
			return nil, &subscriptionFetchError{code: "subscription_" + code, retryAfter: max(0, min(86400, retryAfter))}
		}
		bytes, err := io.ReadAll(io.LimitReader(response.Body, maxBytes+1))
		response.Body.Close()
		if err != nil {
			return nil, subscriptionError("fetch_failed")
		}
		if int64(len(bytes)) > maxBytes {
			return nil, subscriptionError("limit_exceeded")
		}
		var parsed any
		if json.Unmarshal(bytes, &parsed) != nil {
			return nil, subscriptionError("response_invalid")
		}
		return Object{"value": parsed, "bytes": len(bytes), "etag": response.Header.Get("ETag"), "modified": response.Header.Get("Last-Modified"), "fetchedAt": time.Now().Unix()}, nil
	}
	return nil, subscriptionError("redirect_invalid")
}

func subReplaceArray(root any, path string, values []any) error {
	parts, err := subPathParts(path)
	if err != nil || len(parts) == 0 {
		return subscriptionError("pagination_invalid")
	}
	current := object(root)
	for _, part := range parts[:len(parts)-1] {
		if part.wildcard || part.array || current[part.key] == nil {
			return subscriptionError("pagination_invalid")
		}
		current = object(current[part.key])
	}
	last := parts[len(parts)-1]
	if current == nil || last.wildcard || last.array {
		return subscriptionError("pagination_invalid")
	}
	current[last.key] = values
	return nil
}

func (a *App) fetchSubscription(ctx context.Context, descriptor, supplied, previous Object, force bool) (Object, error) {
	parameters, err := subParameters(descriptor, supplied)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	responses, cache := Object{}, clone(previous)
	if cache == nil {
		cache = Object{}
	}
	failures := []Object{}
	remaining := 10
	totalBytes := int64(0)
	now := time.Now().Unix()
	for _, id := range subKeys(object(descriptor["requests"])) {
		spec := object(object(descriptor["requests"])[id])
		old := object(previous[id])
		if !force && old != nil && now < integer(old, "fetchedAt")+integer(spec, "intervalSec") {
			responses[id] = old["value"]
			continue
		}
		err := func() error {
			target, err := subscriptionURL(strings.TrimSuffix(fmt.Sprint(parameters[str(spec, "baseUrlInput")]), "/") + subSubstitute(str(spec, "path"), parameters, true))
			if err != nil {
				return err
			}
			query := target.Query()
			for key, value := range object(spec["query"]) {
				query.Set(key, subSubstitute(fmt.Sprint(value), parameters, false))
			}
			target.RawQuery = query.Encode()
			headers := http.Header{"Accept": []string{"application/json"}}
			for key, value := range object(spec["headers"]) {
				headers.Set(key, subSubstitute(fmt.Sprint(value), parameters, false))
			}
			if spec["method"] == "POST" {
				headers.Set("Content-Type", "application/json")
			}
			pagination := object(spec["pagination"])
			if old != nil && pagination == nil {
				if old["etag"] != nil {
					headers.Set("If-None-Match", str(old, "etag"))
				}
				if old["modified"] != nil {
					headers.Set("If-Modified-Since", str(old, "modified"))
				}
			}
			pages := int64(1)
			cursor := any(float64(1))
			if pagination != nil {
				pages = integer(pagination, "maxPages")
				if pagination["type"] == "cursor" {
					cursor = nil
				}
				if pagination["start"] != nil {
					cursor = pagination["start"]
				}
			}
			var combined Object
			combinedItems := []any{}
			cursors := map[string]bool{}
			for page := int64(0); page < pages; page++ {
				pageURL := *target
				body := subBody(spec["body"], parameters)
				if pagination != nil && cursor != nil {
					if pagination["location"] == "query" {
						query := pageURL.Query()
						query.Set(str(pagination, "parameter"), fmt.Sprint(cursor))
						pageURL.RawQuery = query.Encode()
					} else {
						object(body)[str(pagination, "parameter")] = cursor
					}
				}
				limit := int64(2097152)
				if 10485760-totalBytes < limit {
					limit = 10485760 - totalBytes
				}
				result, err := a.subFetchJSON(ctx, &pageURL, str(spec, "method"), headers, body, &remaining, limit)
				if err != nil {
					return err
				}
				if boolean(result["notModified"]) {
					if old == nil {
						return subscriptionError("response_invalid")
					}
					combined = clone(old)
					combined["fetchedAt"] = now
					break
				}
				totalBytes += integer(result, "bytes")
				if combined == nil {
					combined = result
				}
				if pagination == nil {
					break
				}
				values, ok := subValue(result["value"], str(pagination, "itemsPath")).([]any)
				if !ok {
					return subscriptionError("pagination_invalid")
				}
				combinedItems = append(combinedItems, values...)
				if len(combinedItems) > 1000 {
					return subscriptionError("limit_exceeded")
				}
				next := subValue(result["value"], str(pagination, "nextPath"))
				done := next == nil || next == ""
				if pagination["type"] == "page" {
					done = len(values) == 0 || pagination["nextPath"] != nil && !boolean(next)
				}
				if done {
					break
				}
				if page+1 == pages {
					return subscriptionError("pagination_incomplete")
				}
				if pagination["type"] == "page" {
					cursor = number(cursor) + 1
				} else {
					cursor = next
				}
				key := fmt.Sprint(cursor)
				if len(key) > 2048 || cursors[key] {
					return subscriptionError("pagination_invalid")
				}
				cursors[key] = true
			}
			if pagination != nil {
				if err := subReplaceArray(combined["value"], str(pagination, "itemsPath"), combinedItems); err != nil {
					return err
				}
			}
			responses[id], cache[id] = combined["value"], combined
			return nil
		}()
		if err != nil {
			issue := Object{"requestId": id, "code": err.Error(), "path": "$"}
			var fetchError *subscriptionFetchError
			if errors.As(err, &fetchError) && fetchError.retryAfter > 0 {
				issue["retryAfterSec"] = fetchError.retryAfter
			}
			failures = append(failures, issue)
		}
	}
	return Object{"responses": responses, "cache": cache, "failures": failures, "requests": 10 - remaining}, nil
}
