package polaris

import (
	"context"
	"encoding/base64"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

var subscriptionIconLink = regexp.MustCompile(`(?i)<link\b[^>]*>`)
var subscriptionIconRel = regexp.MustCompile(`(?i)\brel\s*=\s*["']([^"']*)["']`)
var subscriptionIconHref = regexp.MustCompile(`(?i)\bhref\s*=\s*["']([^"']*)["']`)

func (a *App) readSubscriptionIconURL(ctx context.Context, target *url.URL, limit int64, prefix bool) ([]byte, string) {
	for hop := 0; hop < 3; hop++ {
		if _, err := subscriptionURL(target.String()); err != nil {
			return nil, ""
		}
		request, err := http.NewRequestWithContext(ctx, "GET", target.String(), nil)
		if err != nil {
			return nil, ""
		}
		request.Header.Set("Accept", "image/*,text/html;q=0.5")
		response, err := a.subscriptionClient.Do(request)
		if err != nil {
			return nil, ""
		}
		if response.StatusCode >= 300 && response.StatusCode < 400 {
			response.Body.Close()
			next, err := target.Parse(response.Header.Get("Location"))
			if err != nil {
				return nil, ""
			}
			target = next
			continue
		}
		if response.StatusCode != 200 || !prefix && response.ContentLength > limit {
			response.Body.Close()
			return nil, ""
		}
		raw, err := io.ReadAll(io.LimitReader(response.Body, limit+1))
		response.Body.Close()
		if err != nil || len(raw) == 0 || !prefix && int64(len(raw)) > limit {
			return nil, ""
		}
		return raw[:min(int64(len(raw)), limit)], response.Header.Get("Content-Type")
	}
	return nil, ""
}

func subscriptionIconType(raw []byte) string {
	contentType := http.DetectContentType(raw)
	if contains([]string{"image/png", "image/jpeg", "image/gif", "image/webp", "image/x-icon", "image/vnd.microsoft.icon"}, contentType) {
		return contentType
	}
	return ""
}

func (a *App) fetchSubscriptionIcon(ctx context.Context, source *url.URL) ([]byte, string) {
	conventional := source.ResolveReference(&url.URL{Path: "/favicon.ico"})
	if raw, _ := a.readSubscriptionIconURL(ctx, conventional, 256*1024, false); subscriptionIconType(raw) != "" {
		return raw, subscriptionIconType(raw)
	}
	html, contentType := a.readSubscriptionIconURL(ctx, source, 96*1024, true)
	if !strings.Contains(strings.ToLower(contentType), "text/html") {
		return nil, ""
	}
	for _, tag := range subscriptionIconLink.FindAllString(string(html), -1) {
		rel, href := subscriptionIconRel.FindStringSubmatch(tag), subscriptionIconHref.FindStringSubmatch(tag)
		if len(rel) < 2 || len(href) < 2 || !contains(strings.Fields(strings.ToLower(rel[1])), "icon") {
			continue
		}
		target, err := source.Parse(href[1])
		if err != nil {
			continue
		}
		raw, _ := a.readSubscriptionIconURL(ctx, target, 256*1024, false)
		return raw, subscriptionIconType(raw)
	}
	return nil, ""
}

func (a *App) subscriptionIconRoutes() {
	for _, admin := range []bool{true, false} {
		path := "GET /api/public/subscriptions/icons/{id}"
		if admin {
			path = "GET /api/admin/subscriptions/{id}/icon"
		}
		a.route(path, !admin, func(w http.ResponseWriter, r *http.Request) error {
			w.Header().Set("Cache-Control", "private, no-store")
			row, err := a.getSubscription(r.Context(), r.PathValue("id"))
			if err != nil {
				return err
			}
			if !admin {
				if !boolean(row["isPublic"]) || row["archivedAt"] != nil {
					return failure("not_found", 404)
				}
				if err := a.subscriptionPublicAllowed(r, str(row, "category")); err != nil {
					return err
				}
				items, err := a.store.subscriptionItemIndex(r.Context(), str(row, "id"), true)
				if err != nil {
					return err
				}
				visible := false
				for _, item := range items {
					visible = visible || item["removedAt"] == nil
				}
				if !visible {
					return failure("not_found", 404)
				}
			}
			settings, err := a.settings(r.Context())
			if err != nil {
				return err
			}
			if !boolean(settings["site.syncMonitorIcons"]) {
				return failure("not_found", 404)
			}
			source := str(row, "sourcePageUrl")
			if source == "" {
				if hosts := stringsOf(row["sourceHosts"]); len(hosts) > 0 {
					source = "https://" + hosts[0] + "/"
				}
			}
			u, err := subscriptionURL(source)
			if err != nil {
				return failure("not_found", 404)
			}
			u.Path, u.RawPath, u.RawQuery, u.Fragment = "/", "", "", ""
			source = u.String()
			cached, err := a.store.get(r.Context(), "subscription_icon", str(row, "id"))
			if err != nil {
				return err
			}
			ttl := int64(3600)
			if str(cached, "bytes") != "" {
				ttl = 604800
			}
			var raw []byte
			var contentType string
			if cached != nil && str(cached, "source") == source && time.Now().Unix()-integer(cached, "checkedAt") < ttl {
				raw, _ = base64.StdEncoding.DecodeString(str(cached, "bytes"))
				contentType = str(cached, "contentType")
			} else {
				ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
				defer cancel()
				raw, contentType = a.fetchSubscriptionIcon(ctx, u)
				if contentType == "" {
					raw = nil
				}
				if err := a.store.put(r.Context(), "subscription_icon", str(row, "id"), Object{"subscriptionId": row["id"], "source": source, "bytes": base64.StdEncoding.EncodeToString(raw), "contentType": contentType, "checkedAt": time.Now().Unix()}); err != nil {
					return err
				}
			}
			if len(raw) == 0 || contentType == "" {
				return failure("not_found", 404)
			}
			w.Header().Set("Content-Type", contentType)
			w.Header().Set("X-Content-Type-Options", "nosniff")
			_, err = w.Write(raw)
			return err
		})
	}
}
