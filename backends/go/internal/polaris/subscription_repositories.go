package polaris

import (
	"context"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
)

var subscriptionCatalogID = regexp.MustCompile(`^[a-z0-9-]{1,64}$`)
var subscriptionCatalogVersion = regexp.MustCompile(`^\d+\.\d+\.\d+$`)
var subscriptionCatalogPath = regexp.MustCompile(`^(templates|sites)/[a-z0-9-]+/\d+\.\d+\.\d+\.json$`)

func subscriptionRepositoryURL(value string) (string, error) {
	address, err := subscriptionFileURL(value)
	if err != nil {
		return "", err
	}
	u, err := subscriptionURL(address)
	if err != nil {
		return "", err
	}
	if u.RawQuery != "" || !strings.HasSuffix(u.Path, "/catalog.json") {
		return "", failure("subscription_catalog_invalid", 400)
	}
	return u.String(), nil
}

func parseSubscriptionCatalog(value Object) ([]any, error) {
	entries := array(value["entries"])
	if integer(value, "schemaVersion") != 1 || entries == nil || len(entries) > 500 {
		return nil, failure("subscription_catalog_invalid", 502)
	}
	ids := map[string]bool{}
	result := []any{}
	for _, raw := range entries {
		e := object(raw)
		id, version, path := str(e, "id"), str(e, "version"), str(e, "path")
		categories := array(e["categories"])
		if !subscriptionCatalogID.MatchString(id) || ids[id] || strings.TrimSpace(str(e, "name")) == "" || !subscriptionCatalogVersion.MatchString(version) || !subscriptionCatalogPath.MatchString(path) || !strings.HasSuffix(path, "/"+version+".json") || (e["kind"] != "site" && e["kind"] != "template") || len(categories) == 0 || array(e["capabilities"]) == nil || array(e["limitations"]) == nil {
			return nil, failure("subscription_catalog_invalid", 502)
		}
		if _, ok := e["description"].(string); !ok {
			return nil, failure("subscription_catalog_invalid", 502)
		}
		for _, category := range categories {
			if category != "website" && category != "model" {
				return nil, failure("subscription_catalog_invalid", 502)
			}
		}
		ids[id] = true
		entry := Object{"id": id, "name": string([]rune(str(e, "name"))[:min(120, len([]rune(str(e, "name"))))]), "description": string([]rune(str(e, "description"))[:min(2000, len([]rune(str(e, "description"))))]), "version": version, "path": path, "categories": categories, "kind": e["kind"], "origin": "official", "verifiedAt": e["verifiedAt"], "minimumAppVersion": e["minimumAppVersion"]}
		if _, ok := e["verifiedAt"].(string); !ok {
			entry["verifiedAt"] = nil
		}
		if _, ok := e["minimumAppVersion"].(string); !ok {
			delete(entry, "minimumAppVersion")
		}
		for _, field := range []string{"capabilities", "limitations"} {
			values := []any{}
			for _, item := range array(e[field]) {
				if _, ok := item.(string); ok {
					values = append(values, item)
				}
			}
			entry[field] = values
		}
		versions := []any{}
		for _, raw := range array(e["versions"]) {
			v := object(raw)
			if subscriptionCatalogVersion.MatchString(str(v, "version")) && str(v, "path") == path[:strings.LastIndex(path, "/")+1]+str(v, "version")+".json" {
				versions = append(versions, Object{"version": v["version"], "path": v["path"]})
			}
		}
		entry["versions"] = versions
		result = append(result, entry)
	}
	return result, nil
}

func (a *App) refreshSubscriptionRepository(ctx context.Context, previous Object) (Object, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	address, err := subscriptionRepositoryURL(str(previous, "url"))
	if err != nil {
		return nil, err
	}
	u, _ := url.Parse(address)
	remaining := 4
	response, err := a.subFetchJSON(ctx, u, "GET", http.Header{"Accept": []string{"application/json"}}, nil, &remaining, 1048576)
	if err != nil {
		return nil, err
	}
	entries, err := parseSubscriptionCatalog(object(response["value"]))
	if err != nil {
		return nil, err
	}
	row := clone(previous)
	row["entries"], row["fetchedAt"], row["stale"], row["error"] = entries, time.Now().Unix(), false, nil
	row["checkedAt"] = time.Now().Unix()
	if err := a.store.put(ctx, "subscription_repository", str(row, "id"), row); err != nil {
		return nil, err
	}
	return row, nil
}
func repositoryView(row Object) Object {
	view := clone(row)
	delete(view, "entries")
	delete(view, "checkedAt")
	return view
}
func repositoryEntries(row Object) []any {
	result := []any{}
	base, _ := url.Parse(str(row, "url"))
	for _, raw := range array(row["entries"]) {
		entry := clone(object(raw))
		path, _ := url.Parse(str(entry, "path"))
		entry["id"] = str(row, "id") + ":" + str(entry, "id")
		entry["origin"] = "third-party"
		entry["repositoryId"], entry["repositoryName"], entry["sourceUrl"] = row["id"], row["name"], base.ResolveReference(path).String()
		result = append(result, entry)
	}
	return result
}
func (a *App) subscriptionRepositories(ctx context.Context, refresh bool) ([]Object, error) {
	rows, err := a.store.list(ctx, "subscription_repository")
	if err != nil {
		return nil, err
	}
	var tasks sync.WaitGroup
	errors := make([]error, len(rows))
	for i, row := range rows {
		if !refresh && ((!boolean(row["stale"]) && time.Now().Unix()-integer(row, "fetchedAt") < 21600) || (boolean(row["stale"]) && time.Now().Unix()-integer(row, "checkedAt") < 60)) {
			continue
		}
		tasks.Add(1)
		go func(i int, row Object) {
			defer tasks.Done()
			next, err := a.refreshSubscriptionRepository(ctx, row)
			if err == nil {
				rows[i] = next
			} else {
				rows[i] = clone(row)
				rows[i]["stale"], rows[i]["error"] = true, "subscription_catalog_unavailable"
				rows[i]["checkedAt"] = time.Now().Unix()
				if err := a.store.put(ctx, "subscription_repository", str(row, "id"), rows[i]); err != nil {
					errors[i] = err
				}
			}
		}(i, row)
	}
	tasks.Wait()
	for _, err := range errors {
		if err != nil {
			return nil, err
		}
	}
	return rows, nil
}
func (a *App) subscriptionRepositoryRoutes() {
	a.route("POST /api/admin/subscription-repositories", false, func(w http.ResponseWriter, r *http.Request) error {
		input, err := body(r)
		if err != nil {
			return err
		}
		name, err := subscriptionText(input["name"], 120)
		if err != nil {
			return err
		}
		value, err := subscriptionText(input["url"], 2048)
		if err != nil {
			return err
		}
		address, err := subscriptionRepositoryURL(value)
		if err != nil {
			return err
		}
		rows, err := a.store.list(r.Context(), "subscription_repository")
		if err != nil {
			return err
		}
		if len(rows) >= 8 {
			return failure("subscription_limit_exceeded", 413)
		}
		for _, row := range rows {
			if row["url"] == address {
				return failure("subscription_repository_exists", 409)
			}
		}
		row, err := a.refreshSubscriptionRepository(r.Context(), Object{"id": "repo-" + strings.ReplaceAll(uuid(), "-", ""), "name": name, "url": address})
		if err != nil {
			return err
		}
		respond(w, 201, Object{"repository": repositoryView(row)})
		return nil
	})
	a.route("DELETE /api/admin/subscription-repositories/{id}", false, func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("id")
		if !regexp.MustCompile(`^repo-[a-f0-9]{32}$`).MatchString(id) {
			return failure("invalid_request", 400)
		}
		if err := a.store.mutate(r.Context(), func(tx *transaction) error { return tx.remove("subscription_repository", id) }); err != nil {
			return err
		}
		respond(w, 200, Object{"ok": true})
		return nil
	})
}
