package polaris

import (
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/hkdf"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"strings"
	"time"
)

const officialSubscriptionRoot = "https://raw.githubusercontent.com/XingLingQAQ/UptimePolaris-Subscriptions/main/"
const subscriptionSecretDomain = "uptime-polaris-subscription-secrets-v1"

func (a *App) subscriptionCipher(ctx context.Context, create bool) (cipher.AEAD, error) {
	material, err := a.aiKey(ctx, create)
	if err != nil {
		return nil, failure("subscription_key_unavailable", 503)
	}
	key, err := hkdf.Key(sha256.New, material, []byte(subscriptionSecretDomain), "parameters", 32)
	if err != nil {
		return nil, err
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func (a *App) encryptSubscription(ctx context.Context, secrets Object, id string) (string, error) {
	if len(secrets) == 0 {
		return "", nil
	}
	aead, err := a.subscriptionCipher(ctx, true)
	if err != nil {
		return "", err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err := rand.Read(nonce); err != nil {
		return "", err
	}
	value := aead.Seal(nil, nonce, []byte(encode(secrets)), []byte(subscriptionSecretDomain+":"+id))
	return "v1." + base64.StdEncoding.EncodeToString(nonce) + "." + base64.StdEncoding.EncodeToString(value), nil
}
func (a *App) decryptSubscription(ctx context.Context, config Object) (Object, error) {
	value := str(config, "ciphertext")
	if value == "" {
		return Object{}, nil
	}
	parts := strings.Split(value, ".")
	if len(parts) != 3 || parts[0] != "v1" {
		return nil, failure("subscription_credential_unavailable", 503)
	}
	aead, err := a.subscriptionCipher(ctx, false)
	if err != nil {
		return nil, err
	}
	nonce, err := base64.StdEncoding.DecodeString(parts[1])
	if err != nil || len(nonce) != aead.NonceSize() {
		return nil, failure("subscription_credential_unavailable", 503)
	}
	bytes, err := base64.StdEncoding.DecodeString(parts[2])
	if err != nil {
		return nil, failure("subscription_credential_unavailable", 503)
	}
	plain, err := aead.Open(nil, nonce, bytes, []byte(subscriptionSecretDomain+":"+str(config, "id")))
	if err != nil {
		return nil, failure("subscription_credential_unavailable", 503)
	}
	var secrets Object
	if json.Unmarshal(plain, &secrets) != nil {
		return nil, failure("subscription_credential_unavailable", 503)
	}
	return secrets, nil
}

func subscriptionConfigView(config Object) Object {
	view := clone(config)
	delete(view, "ciphertext")
	return view
}
func subscriptionPreviewView(preview Object) Object {
	view := clone(preview)
	delete(view, "owner")
	delete(view, "ciphertext")
	return view
}

func (a *App) subscriptionPreview(ctx context.Context, descriptor, parameters Object, sourceURL, origin, owner string, binding ...Object) (Object, error) {
	if err := validateSubscriptionDescriptor(descriptor); err != nil {
		return nil, err
	}
	values, err := subParameters(descriptor, parameters)
	if err != nil {
		return nil, err
	}
	secrets, ordinary := Object{}, Object{}
	for key, value := range values {
		if object(object(descriptor["inputs"])[key])["type"] == "secret" {
			secrets[key] = value
		} else {
			ordinary[key] = value
		}
	}
	id := uuid()
	now := time.Now().Unix()
	encrypted, err := a.encryptSubscription(ctx, secrets, id)
	if err != nil {
		return nil, err
	}
	var source any
	if sourceURL != "" {
		if _, err := subscriptionURL(sourceURL); err != nil {
			return nil, err
		}
		source = sourceURL
	}
	config := Object{"id": id, "descriptor": descriptor, "parameters": ordinary, "secretNames": subKeys(secrets), "sourceUrl": source, "origin": origin, "modified": false, "fetchedAt": now}
	preview := Object{"id": id, "owner": owner, "ciphertext": encrypted, "config": config, "state": "running", "items": []any{}, "issues": []any{}, "createdAt": now, "expiresAt": now + 600, "error": nil}
	if len(binding) > 0 {
		preview["subscriptionId"], preview["revision"] = binding[0]["subscriptionId"], binding[0]["revision"]
		config["modified"] = boolean(binding[0]["modified"])
	}
	if err := a.store.put(ctx, "subscription_preview", id, preview); err != nil {
		return nil, err
	}
	if len(binding) > 0 && boolean(binding[0]["background"]) {
		initial := clone(preview)
		a.wg.Add(1)
		go func() {
			defer a.wg.Done()
			a.storeLock.RLock()
			defer a.storeLock.RUnlock()
			_, _ = a.completeSubscriptionPreview(a.ctx, preview, values)
		}()
		return initial, nil
	}
	return a.completeSubscriptionPreview(ctx, preview, values)
}

func (a *App) completeSubscriptionPreview(ctx context.Context, preview, values Object) (Object, error) {
	id, now, descriptor := str(preview, "id"), integer(preview, "createdAt"), object(object(preview["config"])["descriptor"])
	fetched, err := a.fetchSubscription(ctx, descriptor, values, Object{}, true)
	if err == nil {
		parsed, parseErr := parseSubscriptionResponses(descriptor, object(fetched["responses"]), now)
		err = parseErr
		if err == nil {
			parsed = clone(parsed)
			secrets := Object{}
			for key, value := range values {
				if object(object(descriptor["inputs"])[key])["type"] == "secret" {
					secrets[key] = value
				}
			}
			if err := redactSubscriptionItems(array(parsed["items"]), secrets); err != nil {
				preview["state"], preview["error"] = "failed", err.Error()
				if writeErr := a.store.put(ctx, "subscription_preview", id, preview); writeErr != nil {
					return nil, writeErr
				}
				return preview, nil
			}
			fetched = clone(fetched)
			issues := append(array(fetched["failures"]), array(parsed["issues"])...)
			redactSubscriptionIssues(issues, secrets)
			preview["items"], preview["issues"], preview["state"] = parsed["items"], issues, "ready"
			if len(issues) > 0 {
				preview["state"] = "partial"
				if len(array(parsed["items"])) == 0 {
					preview["state"], preview["error"] = "failed", "subscription_preview_failed"
				}
			}
		}
	}
	if err != nil {
		preview["state"], preview["error"] = "failed", err.Error()
	}
	if str(preview, "subscriptionId") != "" && preview["state"] != "failed" {
		diff, err := a.subscriptionIdentityDiff(ctx, preview)
		if err != nil {
			return nil, err
		}
		preview["identity"] = diff
	}
	if err := a.store.put(ctx, "subscription_preview", id, preview); err != nil {
		return nil, err
	}
	return preview, nil
}

func (a *App) readSubscriptionDescriptor(ctx context.Context, address string) (Object, error) {
	target, err := subscriptionURL(address)
	if err != nil {
		return nil, err
	}
	remaining := 4
	result, err := a.subFetchJSON(ctx, target, "GET", http.Header{"Accept": []string{"application/json"}}, nil, &remaining, 262144)
	if err != nil {
		return nil, err
	}
	descriptor := object(result["value"])
	if err := validateSubscriptionDescriptor(descriptor); err != nil {
		return nil, err
	}
	return descriptor, nil
}

func subscriptionFileURL(address string) (string, error) {
	target, err := subscriptionURL(address)
	if err != nil {
		return "", err
	}
	parts := strings.Split(strings.Trim(target.Path, "/"), "/")
	if target.Hostname() == "github.com" && len(parts) >= 5 && parts[2] == "blob" && strings.HasSuffix(parts[len(parts)-1], ".json") {
		return "https://raw.githubusercontent.com/" + parts[0] + "/" + parts[1] + "/" + strings.Join(parts[3:], "/"), nil
	}
	return target.String(), nil
}

func (a *App) cachedSubscriptionDescriptor(ctx context.Context, address string, force bool) (Object, error) {
	key, err := subscriptionFileURL(address)
	if err != nil {
		return nil, err
	}
	cached, err := a.store.get(ctx, "subscription_remote_file", key)
	if err != nil {
		return nil, err
	}
	now, age := time.Now().Unix(), int64(86400)
	if force {
		age = 60
	}
	if cached != nil && now-integer(cached, "checkedAt") < age {
		return object(cached["descriptor"]), nil
	}
	target, _ := subscriptionURL(key)
	headers := http.Header{"Accept": []string{"application/json"}}
	if str(cached, "etag") != "" {
		headers.Set("If-None-Match", str(cached, "etag"))
	}
	if str(cached, "modified") != "" {
		headers.Set("If-Modified-Since", str(cached, "modified"))
	}
	remaining := 4
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	result, err := a.subFetchJSON(ctx, target, "GET", headers, nil, &remaining, 262144)
	if err != nil {
		return nil, err
	}
	descriptor := object(result["value"])
	if boolean(result["notModified"]) && cached != nil {
		descriptor = object(cached["descriptor"])
		result["etag"], result["modified"] = cached["etag"], cached["modified"]
	}
	if err := validateSubscriptionDescriptor(descriptor); err != nil {
		return nil, err
	}
	if err = a.store.put(ctx, "subscription_remote_file", key, Object{"descriptor": descriptor, "checkedAt": now, "expiresAt": now + 7*86400, "etag": result["etag"], "modified": result["modified"]}); err != nil {
		return nil, err
	}
	return descriptor, nil
}

func (a *App) subscriptionCatalog(ctx context.Context, refresh bool) (Object, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cached, err := a.store.get(ctx, "subscription_catalog", "official")
	if err != nil {
		return nil, err
	}
	now := time.Now().Unix()
	age := int64(21600)
	if refresh {
		age = 60
	}
	if cached != nil && now-integer(cached, "fetchedAt") < age {
		cached["stale"], cached["error"] = false, nil
		return cached, nil
	}
	target, _ := subscriptionURL(officialSubscriptionRoot + "catalog.json")
	remaining := 4
	result, fetchErr := a.subFetchJSON(ctx, target, "GET", http.Header{"Accept": []string{"application/json"}}, nil, &remaining, 1048576)
	if fetchErr == nil {
		entries, parseErr := parseSubscriptionCatalog(object(result["value"]))
		valid := parseErr == nil
		if valid {
			cached = Object{"id": "official", "entries": entries, "fetchedAt": now, "stale": false, "error": nil}
			if err := a.store.put(ctx, "subscription_catalog", "official", cached); err != nil {
				return nil, err
			}
			return cached, nil
		}
	}
	if cached == nil {
		template := subscriptionTemplates[0]
		cached = Object{"entries": []Object{{"id": template["id"], "name": template["name"], "description": template["description"], "version": template["version"], "categories": template["categories"], "capabilities": template["capabilities"], "kind": "template", "path": "templates/uptime-kuma/" + str(template, "version") + ".json", "verifiedAt": nil, "limitations": []any{}, "origin": "official"}}, "fetchedAt": nil}
	}
	cached["stale"], cached["error"] = true, "subscription_catalog_unavailable"
	return cached, nil
}

func (a *App) subscriptionTemplate(ctx context.Context, id string) (Object, string, error) {
	if strings.HasPrefix(id, "repo-") && strings.Contains(id, ":") {
		parts := strings.Split(id, ":")
		if len(parts) != 2 {
			return nil, "", failure("not_found", 404)
		}
		repository, err := a.store.get(ctx, "subscription_repository", parts[0])
		if err != nil {
			return nil, "", err
		}
		if repository == nil {
			return nil, "", failure("not_found", 404)
		}
		for _, raw := range repositoryEntries(repository) {
			entry := object(raw)
			if entry["id"] != id {
				continue
			}
			address := str(entry, "sourceUrl")
			descriptor, err := a.cachedSubscriptionDescriptor(ctx, address, false)
			if err != nil {
				return nil, "", err
			}
			if descriptor["id"] != parts[1] || descriptor["version"] != entry["version"] {
				return nil, "", subscriptionError("version_conflict")
			}
			return descriptor, address, nil
		}
		return nil, "", failure("not_found", 404)
	}
	if strings.HasPrefix(id, "local-") {
		config, err := a.store.get(ctx, "subscription_library", id)
		if err != nil {
			return nil, "", err
		}
		if config == nil {
			return nil, "", failure("not_found", 404)
		}
		return object(config["descriptor"]), str(config, "sourceUrl"), nil
	}
	catalog, err := a.subscriptionCatalog(ctx, false)
	if err != nil {
		return nil, "", err
	}
	catalog = clone(catalog)
	for _, raw := range array(catalog["entries"]) {
		entry := object(raw)
		if entry["id"] != id {
			continue
		}
		address := officialSubscriptionRoot + str(entry, "path")
		if id == "uptime-kuma" && entry["version"] == subscriptionTemplates[0]["version"] {
			return clone(subscriptionTemplates[0]), address, nil
		}
		cacheID := id + ":" + str(entry, "version")
		cached, err := a.store.get(ctx, "subscription_template", cacheID)
		if err != nil {
			return nil, "", err
		}
		if cached != nil {
			return object(cached["descriptor"]), address, nil
		}
		descriptor, err := a.readSubscriptionDescriptor(ctx, address)
		if err != nil {
			return nil, "", err
		}
		if descriptor["id"] != id || descriptor["version"] != entry["version"] {
			return nil, "", subscriptionError("version_conflict")
		}
		if err := a.store.put(ctx, "subscription_template", cacheID, Object{"id": cacheID, "descriptor": descriptor}); err != nil {
			return nil, "", err
		}
		return descriptor, address, nil
	}
	return nil, "", failure("not_found", 404)
}

func (a *App) checkSubscriptionUpdate(ctx context.Context, config Object, subscriptionID string, force bool) (Object, error) {
	cached, err := a.store.get(ctx, "subscription_update", str(config, "id"))
	if err != nil {
		return nil, err
	}
	now, age := time.Now().Unix(), int64(86400)
	if force {
		age = 60
	}
	if cached != nil && now-integer(cached, "checkedAt") < age {
		return cached, nil
	}
	if str(config, "sourceUrl") == "" {
		return nil, failure("subscription_update_source_missing", 400)
	}
	var candidate Object
	sourceURL := str(config, "sourceUrl")
	if config["origin"] == "official" {
		var catalog Object
		catalog, err = a.subscriptionCatalog(ctx, force)
		found := false
		if err == nil {
			for _, raw := range array(catalog["entries"]) {
				entry := object(raw)
				if entry["id"] == object(config["descriptor"])["id"] {
					sourceURL = officialSubscriptionRoot + str(entry, "path")
					found = true
					break
				}
			}
		}
		if !found || boolean(catalog["stale"]) {
			err = failure("subscription_catalog_unavailable", 502)
		}
	}
	if err == nil {
		candidate, err = a.cachedSubscriptionDescriptor(ctx, sourceURL, force)
	}
	if err == nil && candidate["id"] != object(config["descriptor"])["id"] {
		err = failure("subscription_version_conflict", 409)
	}
	update := Object{"checkedAt": now, "version": nil, "changed": false, "conflict": false, "error": nil, "subscriptionId": subscriptionID}
	if err != nil {
		update["error"] = "subscription_fetch_failed"
		if cached != nil {
			for _, key := range []string{"version", "changed", "conflict", "candidate"} {
				update[key] = cached[key]
			}
		}
	} else {
		changed := encode(candidate) != encode(config["descriptor"])
		update["version"], update["changed"], update["conflict"], update["candidate"] = candidate["version"], changed, changed && candidate["version"] == object(config["descriptor"])["version"], candidate
		update["sourceUrl"] = sourceURL
	}
	if err := a.store.put(ctx, "subscription_update", str(config, "id"), update); err != nil {
		return nil, err
	}
	return update, nil
}

func (a *App) scheduleSubscriptionUpdates(rows []Object) {
	if len(rows) == 0 {
		return
	}
	a.wg.Add(1)
	go func() {
		defer a.wg.Done()
		a.storeLock.RLock()
		defer a.storeLock.RUnlock()
		for _, row := range rows[:min(2, len(rows))] {
			id, owner := "subscription-update:"+str(row, "configId"), uuid()
			claimed, err := a.store.claim(a.ctx, id, owner, time.Now().Unix(), 60, false)
			if err != nil || !claimed {
				continue
			}
			config, err := a.store.get(a.ctx, "subscription_config", str(row, "configId"))
			if err == nil && config != nil {
				_, _ = a.checkSubscriptionUpdate(a.ctx, config, str(row, "id"), false)
			}
			_ = a.store.release(a.ctx, id, owner, time.Now().Unix()+60)
		}
	}()
}
