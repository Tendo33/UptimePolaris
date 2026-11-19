package polaris

import (
	"net/http"
	"time"
)

func publicSubscriptionItem(item, subscription Object) Object {
	view := subscriptionItemView(item, subscription, time.Now().Unix())
	name := str(item, "localName")
	if name == "" {
		name = str(item, "name")
	}
	return Object{"id": view["id"], "category": view["category"], "name": name, "source": Object{"id": subscription["id"], "name": subscription["name"], "url": subscription["sourcePageUrl"]}, "group": view["group"], "modelId": view["modelId"], "provider": view["provider"], "protocol": view["protocol"], "mode": view["mode"], "freshness": view["freshness"], "status": view["displayStatus"], "observation": view["observation"], "recent": view["recent"], "availability": view["availability"]}
}
func (a *App) subscriptionPublicAllowed(r *http.Request, category string) error {
	if category == "model" {
		return a.aiPublicPage(r)
	}
	kind, enabled, configured, _, err := a.pageContext(r)
	if err != nil {
		return err
	}
	if kind != "monitor" || !enabled || !configured {
		return failure("not_found", 404)
	}
	return nil
}
func (a *App) subscriptionPublicRoutes() {
	a.route("GET /api/public/subscriptions/items", true, func(w http.ResponseWriter, r *http.Request) error {
		category, err := subscriptionCategory(r.URL.Query().Get("category"))
		if err != nil {
			return err
		}
		if err := a.subscriptionPublicAllowed(r, category); err != nil {
			return err
		}
		subscriptions, err := a.store.list(r.Context(), "subscription")
		if err != nil {
			return err
		}
		visible := map[string]Object{}
		for _, row := range subscriptions {
			if row["category"] == category && boolean(row["isPublic"]) && row["archivedAt"] == nil {
				visible[str(row, "id")] = row
			}
		}
		items, err := a.store.list(r.Context(), "subscription_item")
		if err != nil {
			return err
		}
		sortSubscriptionItems(items)
		result := []Object{}
		for _, item := range items {
			subscription := visible[str(item, "subscriptionId")]
			if subscription != nil && boolean(item["selected"]) && boolean(item["isPublic"]) && item["removedAt"] == nil {
				result = append(result, publicSubscriptionItem(item, subscription))
			}
		}
		page, err := subscriptionPage(r, result)
		if err != nil {
			return err
		}
		respond(w, 200, page)
		return nil
	})
	for _, history := range []bool{false, true} {
		path := "GET /api/public/subscriptions/items/{id}"
		if history {
			path += "/history"
		}
		a.route(path, true, func(w http.ResponseWriter, r *http.Request) error {
			item, err := a.store.get(r.Context(), "subscription_item", r.PathValue("id"))
			if err != nil {
				return err
			}
			if item == nil || !boolean(item["selected"]) || !boolean(item["isPublic"]) || item["removedAt"] != nil {
				return failure("not_found", 404)
			}
			subscription, err := a.getSubscription(r.Context(), str(item, "subscriptionId"))
			if err != nil {
				return err
			}
			if !boolean(subscription["isPublic"]) || subscription["archivedAt"] != nil {
				return failure("not_found", 404)
			}
			if err := a.subscriptionPublicAllowed(r, str(subscription, "category")); err != nil {
				return err
			}
			if history {
				respond(w, 200, subscriptionHistory(item))
			} else {
				respond(w, 200, Object{"item": publicSubscriptionItem(item, subscription)})
			}
			return nil
		})
	}
}
