package polaris

import (
	"context"
	"net/http"
	"strings"
	"time"
)

func (a *App) validSubscriptionPreview(r *http.Request, id string) (Object, error) {
	preview, err := a.store.get(r.Context(), "subscription_preview", id)
	if err != nil {
		return nil, err
	}
	if preview == nil || preview["owner"] != a.subscriptionOwner(r) || integer(preview, "expiresAt") <= time.Now().Unix() {
		return nil, failure("subscription_preview_expired", 409)
	}
	return preview, nil
}
func (a *App) configFromSubscriptionPreview(ctx context.Context, preview Object) (Object, error) {
	secrets, err := a.decryptSubscription(ctx, preview)
	if err != nil {
		return nil, err
	}
	config := clone(object(preview["config"]))
	config["id"] = uuid()
	config["ciphertext"], err = a.encryptSubscription(ctx, secrets, str(config, "id"))
	return config, err
}
func subscriptionOrigins(descriptor, parameters Object) (string, error) {
	values, err := subParameters(descriptor, parameters)
	if err != nil {
		return "", err
	}
	origins := map[string]bool{}
	for _, raw := range object(descriptor["requests"]) {
		request := object(raw)
		target, err := subscriptionURL(strings.TrimSuffix(str(values, str(request, "baseUrlInput")), "/") + subSubstitute(str(request, "path"), values, true))
		if err != nil {
			return "", err
		}
		origins[target.Scheme+"://"+target.Host] = true
	}
	out := Object{}
	for key := range origins {
		out[key] = true
	}
	return strings.Join(subKeys(out), "\n"), nil
}

func subscriptionCredentialBindings(descriptor, parameters Object) (Object, error) {
	values, err := subParameters(descriptor, parameters)
	if err != nil {
		return nil, err
	}
	result := Object{}
	for name, raw := range object(descriptor["inputs"]) {
		if object(raw)["type"] != "secret" {
			continue
		}
		origins := Object{}
		for _, raw := range object(descriptor["requests"]) {
			request := object(raw)
			if !strings.Contains(encode(request), "{"+name+"}") {
				continue
			}
			target, err := subscriptionURL(strings.TrimSuffix(str(values, str(request, "baseUrlInput")), "/") + subSubstitute(str(request, "path"), values, true))
			if err != nil {
				return nil, err
			}
			origins[target.Scheme+"://"+target.Host] = true
		}
		result[name] = strings.Join(subKeys(origins), "\n")
	}
	return result, nil
}
func (a *App) subscriptionConfigRoutes() {
	a.route("GET /api/admin/subscription-catalog", false, func(w http.ResponseWriter, r *http.Request) error {
		catalog, err := a.subscriptionCatalog(r.Context(), false)
		if err != nil {
			return err
		}
		catalog = clone(catalog)
		local, err := a.store.list(r.Context(), "subscription_library")
		if err != nil {
			return err
		}
		for _, row := range local {
			descriptor := object(row["descriptor"])
			catalog["entries"] = append(array(catalog["entries"]), Object{"id": row["id"], "name": descriptor["name"], "description": descriptor["description"], "version": descriptor["version"], "categories": descriptor["categories"], "kind": "template", "path": "", "capabilities": descriptor["capabilities"], "verifiedAt": nil, "limitations": []any{}, "origin": "local"})
		}
		subscriptions, err := a.store.list(r.Context(), "subscription")
		if err != nil {
			return err
		}
		installed := []Object{}
		for _, row := range subscriptions {
			config, err := a.store.get(r.Context(), "subscription_config", str(row, "configId"))
			if err != nil {
				return err
			}
			if config != nil {
				installed = append(installed, config)
			}
		}
		for _, raw := range array(catalog["entries"]) {
			entry := object(raw)
			entry["installedCount"] = 0
			for _, config := range installed {
				matches := config["origin"] == "official" && entry["origin"] == "official" && object(config["descriptor"])["id"] == entry["id"]
				if entry["origin"] == "local" {
					for _, imported := range local {
						if imported["id"] == entry["id"] {
							matches = config["origin"] == "local" && object(config["descriptor"])["id"] == object(imported["descriptor"])["id"] && config["sourceUrl"] == imported["sourceUrl"]
						}
					}
				}
				if matches {
					entry["installedCount"] = integer(entry, "installedCount") + 1
				}
			}
		}
		respond(w, 200, catalog)
		return nil
	})
	a.route("POST /api/admin/subscription-catalog/refresh", false, func(w http.ResponseWriter, r *http.Request) error {
		catalog, err := a.subscriptionCatalog(r.Context(), true)
		if err != nil {
			return err
		}
		respond(w, 200, catalog)
		return nil
	})
	a.route("GET /api/admin/subscription-catalog/{templateId}", false, func(w http.ResponseWriter, r *http.Request) error {
		descriptor, address, err := a.subscriptionTemplate(r.Context(), r.PathValue("templateId"))
		if err != nil {
			return err
		}
		respond(w, 200, Object{"descriptor": descriptor, "sourceUrl": address})
		return nil
	})
	a.route("POST /api/admin/subscription-configs/import", false, func(w http.ResponseWriter, r *http.Request) error {
		input, err := body(r)
		if err != nil {
			return err
		}
		descriptor := object(input["descriptor"])
		var address any
		if input["url"] != nil {
			value, err := subscriptionText(input["url"], 2048)
			if err != nil {
				return err
			}
			value, err = subscriptionFileURL(value)
			if err != nil {
				return err
			}
			descriptor, err = a.cachedSubscriptionDescriptor(r.Context(), value, false)
			if err != nil {
				return err
			}
			address = value
		} else if err := validateSubscriptionDescriptor(descriptor); err != nil {
			return err
		}
		id := "local-" + uuid()
		config := Object{"id": id, "descriptor": descriptor, "sourceUrl": address, "origin": "local", "fetchedAt": time.Now().Unix()}
		if err := a.store.mutate(r.Context(), func(tx *transaction) error {
			var count int
			if err := tx.tx.QueryRowContext(r.Context(), "SELECT COUNT(*) FROM polaris_documents WHERE kind='subscription_library'").Scan(&count); err != nil {
				return err
			}
			if count >= 500 {
				return failure("subscription_limit_exceeded", 413)
			}
			return tx.put("subscription_library", id, config)
		}); err != nil {
			return err
		}
		respond(w, 200, config)
		return nil
	})
	a.route("POST /api/admin/subscription-configs/preview", false, func(w http.ResponseWriter, r *http.Request) error {
		input, err := body(r)
		if err != nil {
			return err
		}
		descriptor, address, origin := object(input["descriptor"]), str(input, "sourceUrl"), "local"
		if input["templateId"] != nil {
			id, err := subscriptionText(input["templateId"], 64)
			if err != nil {
				return err
			}
			descriptor, address, err = a.subscriptionTemplate(r.Context(), id)
			if err != nil {
				return err
			}
			origin = "official"
			if strings.HasPrefix(id, "local-") {
				origin = "local"
			}
		}
		preview, err := a.subscriptionPreview(r.Context(), descriptor, object(input["parameters"]), address, origin, a.subscriptionOwner(r), Object{"background": true})
		if err != nil {
			return err
		}
		respond(w, 202, Object{"preview": subscriptionPreviewView(preview), "previewId": preview["id"]})
		return nil
	})
	a.route("GET /api/admin/subscription-previews/{previewId}", false, func(w http.ResponseWriter, r *http.Request) error {
		preview, err := a.validSubscriptionPreview(r, r.PathValue("previewId"))
		if err != nil {
			return err
		}
		respond(w, 200, Object{"preview": subscriptionPreviewView(preview)})
		return nil
	})
	a.route("DELETE /api/admin/subscription-configs/{configId}", false, func(w http.ResponseWriter, r *http.Request) error {
		id := r.PathValue("configId")
		if !strings.HasPrefix(id, "local-") {
			return failure("invalid_request", 400)
		}
		if err := a.store.mutate(r.Context(), func(tx *transaction) error { return tx.remove("subscription_library", id) }); err != nil {
			return err
		}
		respond(w, 200, Object{"ok": true})
		return nil
	})
	for _, export := range []bool{false, true} {
		path := "GET /api/admin/subscriptions/{id}/config"
		if export {
			path += "/export"
		}
		a.route(path, false, func(w http.ResponseWriter, r *http.Request) error {
			subscription, err := a.getSubscription(r.Context(), r.PathValue("id"))
			if err != nil {
				return err
			}
			config, err := a.store.get(r.Context(), "subscription_config", str(subscription, "configId"))
			if err != nil {
				return err
			}
			if config == nil {
				return failure("not_found", 404)
			}
			if export {
				w.Header().Set("Content-Disposition", `attachment; filename="`+str(object(config["descriptor"]), "id")+`.json"`)
				respond(w, 200, config["descriptor"])
			} else {
				respond(w, 200, Object{"config": subscriptionConfigView(config), "revision": subscription["revision"]})
			}
			return nil
		})
	}
	a.route("POST /api/admin/subscriptions/{id}/config/check-update", false, func(w http.ResponseWriter, r *http.Request) error {
		subscription, err := a.getSubscription(r.Context(), r.PathValue("id"))
		if err != nil {
			return err
		}
		config, err := a.store.get(r.Context(), "subscription_config", str(subscription, "configId"))
		if err != nil {
			return err
		}
		if str(config, "sourceUrl") == "" {
			return failure("subscription_update_source_missing", 400)
		}
		update, err := a.checkSubscriptionUpdate(r.Context(), config, str(subscription, "id"), true)
		if err != nil {
			return err
		}
		if update["error"] != nil {
			return failure(str(update, "error"), 502)
		}
		update["currentVersion"] = object(config["descriptor"])["version"]
		respond(w, 200, update)
		return nil
	})
	a.route("POST /api/admin/subscriptions/{id}/config/preview", false, a.previewSubscriptionConfig)
	a.route("PUT /api/admin/subscriptions/{id}/config", false, a.applySubscriptionConfig)
}

func (a *App) previewSubscriptionConfig(w http.ResponseWriter, r *http.Request) error {
	input, err := body(r)
	if err != nil {
		return err
	}
	subscription, err := a.getSubscription(r.Context(), r.PathValue("id"))
	if err != nil {
		return err
	}
	if err := subscriptionRevision(subscription, input); err != nil {
		return err
	}
	config, err := a.store.get(r.Context(), "subscription_config", str(subscription, "configId"))
	if err != nil {
		return err
	}
	if config == nil {
		return failure("not_found", 404)
	}
	candidate := config
	if input["rollback"] == true {
		candidate, err = a.store.get(r.Context(), "subscription_previous", str(subscription, "id"))
		if err != nil {
			return err
		}
		if candidate == nil {
			return failure("not_found", 404)
		}
	}
	descriptor := object(candidate["descriptor"])
	if input["descriptor"] != nil && input["rollback"] != true {
		descriptor = object(input["descriptor"])
	}
	if err := validateSubscriptionDescriptor(descriptor); err != nil {
		return err
	}
	if !contains(stringsOf(descriptor["categories"]), str(subscription, "category")) {
		return failure("subscription_category_invalid", 400)
	}
	secrets, err := a.decryptSubscription(r.Context(), config)
	if err != nil {
		return err
	}
	parameters := clone(object(candidate["parameters"]))
	if parameters == nil {
		parameters = Object{}
	}
	oldValues := clone(object(config["parameters"]))
	for key, value := range secrets {
		if spec := object(object(descriptor["inputs"])[key]); spec != nil && spec["type"] != "secret" {
			return failure("subscription_secret_type_changed", 409)
		}
		parameters[key] = value
		oldValues[key] = value
	}
	for key := range parameters {
		if object(descriptor["inputs"])[key] == nil {
			delete(parameters, key)
		}
	}
	for key, value := range object(input["parameters"]) {
		parameters[key] = value
	}
	oldBindings, err := subscriptionCredentialBindings(object(config["descriptor"]), oldValues)
	if err != nil {
		return err
	}
	newBindings, err := subscriptionCredentialBindings(descriptor, parameters)
	if err != nil {
		return err
	}
	for key := range secrets {
		if object(descriptor["inputs"])[key] != nil && oldBindings[key] != newBindings[key] && object(input["parameters"])[key] == nil {
			return failure("subscription_credentials_rebind_required", 409)
		}
	}
	update, err := a.store.get(r.Context(), "subscription_update", str(config, "id"))
	if err != nil {
		return err
	}
	modified := encode(descriptor) != encode(config["descriptor"]) || boolean(config["modified"])
	if update != nil && encode(descriptor) == encode(update["candidate"]) {
		modified = false
	}
	sourceURL := str(config, "sourceUrl")
	if !modified && str(update, "sourceUrl") != "" {
		sourceURL = str(update, "sourceUrl")
	}
	if input["rollback"] == true {
		sourceURL = str(candidate, "sourceUrl")
	}
	preview, err := a.subscriptionPreview(r.Context(), descriptor, parameters, sourceURL, str(config, "origin"), a.subscriptionOwner(r), Object{"background": true, "subscriptionId": subscription["id"], "revision": subscription["revision"], "modified": modified})
	if err != nil {
		return err
	}
	respond(w, 202, Object{"preview": subscriptionPreviewView(preview), "previewId": preview["id"]})
	return nil
}
func (a *App) applySubscriptionConfig(w http.ResponseWriter, r *http.Request) error {
	input, err := body(r)
	if err != nil {
		return err
	}
	preview, err := a.validSubscriptionPreview(r, str(input, "previewId"))
	if err != nil {
		return err
	}
	if preview["state"] != "ready" || preview["subscriptionId"] != r.PathValue("id") || preview["revision"] != input["revision"] {
		return failure("subscription_preview_expired", 409)
	}
	config, err := a.configFromSubscriptionPreview(r.Context(), preview)
	if err != nil {
		return err
	}
	config["subscriptionId"] = r.PathValue("id")
	var result Object
	err = a.store.mutate(r.Context(), func(tx *transaction) error {
		row, err := tx.get("subscription", r.PathValue("id"))
		if err != nil {
			return err
		}
		if err := subscriptionRevision(row, input); err != nil {
			return err
		}
		previous, err := tx.get("subscription_config", str(row, "configId"))
		if err != nil {
			return err
		}
		if previous == nil {
			return failure("not_found", 404)
		}
		if subscriptionIdentity(previous) != subscriptionIdentity(config) {
			if input["confirmIdentityChange"] != true {
				return failure("subscription_identity_confirmation_required", 409)
			}
			all, err := tx.store.subscriptionDocuments(r.Context(), tx.tx, "subscription_item", str(row, "id"))
			if err != nil {
				return err
			}
			items := []Object{}
			for _, item := range all {
				if item["subscriptionId"] == row["id"] {
					items = append(items, item)
				}
			}
			mapped, err := remapSubscriptionIdentities(items, array(preview["items"]), input["identityMappings"], time.Now().Unix())
			if err != nil {
				return err
			}
			for _, item := range mapped {
				if err := tx.put("subscription_item", str(item, "id"), item); err != nil {
					return err
				}
			}
		}
		if err := tx.put("subscription_previous", str(row, "id"), previous); err != nil {
			return err
		}
		if err := tx.remove("subscription_update", str(previous, "id")); err != nil {
			return err
		}
		if err := tx.put("subscription_config", str(config, "id"), config); err != nil {
			return err
		}
		if _, err := tx.tx.ExecContext(r.Context(), tx.store.query("DELETE FROM polaris_documents WHERE kind='subscription_config' AND "+tx.store.jsonField("subscriptionId")+"=? AND id<>?"), str(row, "id"), str(config, "id")); err != nil {
			return err
		}
		row["configId"], row["revision"], row["syncRevision"], row["updatedAt"], row["templateName"], row["templateVersion"] = config["id"], uuid(), uuid(), time.Now().Unix(), object(config["descriptor"])["name"], object(config["descriptor"])["version"]
		row["sourceHosts"] = subscriptionSourceHosts(config)
		row["sourcePageUrl"] = subscriptionSourcePage(config)
		row["sourceUrl"] = config["sourceUrl"]
		object(row["runtime"])["nextDueAt"] = time.Now().Unix()
		result = row
		if err := tx.remove("subscription_cache", str(row, "id")); err != nil {
			return err
		}
		return tx.put("subscription", str(row, "id"), row)
	})
	if err != nil {
		return err
	}
	respond(w, 200, Object{"subscription": result})
	return nil
}
