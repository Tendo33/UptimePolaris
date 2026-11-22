package polaris

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"

	"golang.org/x/net/html"
)

var kumaManifestPath = regexp.MustCompile("(?i)^/api/status-page/([a-z0-9_-]+)/manifest[.]json$")
var kumaStatusPageSuffix = regexp.MustCompile("/(?:status(?:/[^/]+)?|status-page)/?$")

func (a *App) resolveSubscriptionPageParameters(ctx context.Context, descriptor, parameters Object) (Object, error) {
	page, inputs := object(descriptor["sourcePage"]), object(descriptor["inputs"])
	slug := object(inputs["slug"])
	if descriptor["id"] != "uptime-kuma" || page["baseUrlInput"] != "baseUrl" || page["path"] != "/status/{slug}" ||
		object(inputs["baseUrl"])["type"] != "url" || slug["type"] != "string" || slug["required"] != true || slug["default"] != nil {
		return parameters, nil
	}
	address, ok := parameters["baseUrl"].(string)
	if (parameters["slug"] != nil && parameters["slug"] != "") || !ok || address == "" {
		return parameters, nil
	}
	if len(address) > 8192 || strings.ContainsAny(address, "\x00\r\n") {
		return nil, subscriptionError("parameters_invalid")
	}
	target, err := subscriptionURL(address)
	if err != nil {
		return nil, err
	}
	if target.RawQuery != "" {
		return nil, subscriptionError("parameters_invalid")
	}
	unresolved := subscriptionError("source_page_unresolved")
	if a.subscriptionClient == nil {
		return nil, unresolved
	}
	hostname := target.Hostname()
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	for redirects := 0; ; redirects++ {
		request, err := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if err != nil {
			return nil, unresolved
		}
		request.Header.Set("Accept", "text/html")
		response, err := a.subscriptionClient.Do(request)
		if err != nil {
			return nil, unresolved
		}
		switch response.StatusCode {
		case 301, 302, 303, 307, 308:
			response.Body.Close()
			location := response.Header.Get("Location")
			if location == "" || redirects >= 3 {
				return nil, unresolved
			}
			next, err := target.Parse(location)
			if err != nil || !strings.EqualFold(next.Hostname(), hostname) {
				return nil, unresolved
			}
			next.Fragment, next.RawFragment = "", ""
			target, err = subscriptionURL(next.String())
			if err != nil {
				return nil, err
			}
			continue
		}
		if response.StatusCode < 200 || response.StatusCode > 299 {
			response.Body.Close()
			return nil, unresolved
		}
		const maxPageBytes = 256 * 1024
		data, err := io.ReadAll(io.LimitReader(response.Body, maxPageBytes+1))
		response.Body.Close()
		if err != nil {
			return nil, unresolved
		}
		if len(data) > maxPageBytes {
			return nil, subscriptionError("limit_exceeded")
		}
		slug := kumaStatusPageSlug(data)
		if slug == "" {
			return nil, unresolved
		}
		path := strings.TrimSuffix(kumaStatusPageSuffix.ReplaceAllString(target.EscapedPath(), ""), "/")
		result := clone(parameters)
		result["baseUrl"], result["slug"] = target.Scheme+"://"+target.Host+path, slug
		return result, nil
	}
}

func kumaStatusPageSlug(data []byte) string {
	parser := html.NewTokenizer(bytes.NewReader(data))
	for {
		switch parser.Next() {
		case html.ErrorToken:
			return ""
		case html.StartTagToken, html.SelfClosingTagToken:
			tag := parser.Token()
			if tag.Data != "link" {
				continue
			}
			var rel, href string
			for _, attr := range tag.Attr {
				switch attr.Key {
				case "rel":
					rel = attr.Val
				case "href":
					href = attr.Val
				}
			}
			if contains(strings.Fields(strings.ToLower(rel)), "manifest") {
				if match := kumaManifestPath.FindStringSubmatch(href); match != nil {
					return match[1]
				}
			}
		}
	}
}
