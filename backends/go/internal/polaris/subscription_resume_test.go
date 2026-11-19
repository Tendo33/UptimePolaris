package polaris

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

func TestSubscriptionResumesCommittedBatches(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	now := time.Now().Unix()
	subscription := clone(Object{"id": "resume-fixture", "name": "Resume", "category": "website", "enabled": true, "archivedAt": nil, "syncRevision": "v1", "revision": "r1", "configId": "resume-config", "intervalSec": 60, "staleAfterSec": 300, "autoSubscribe": false, "notifications": Object{"monitor": Object{"notificationEnabled": false}, "sync": Object{"notificationEnabled": false, "afterSec": 300}}, "runtime": Object{}})
	config := Object{"id": "resume-config", "descriptor": subscriptionFixture(t, "json-website"), "parameters": Object{"baseUrl": "https://status.example.com"}, "ciphertext": ""}
	sources := []any{}
	for i := 0; i < 1000; i++ {
		source := clone(Object{"sourceItemId": fmt.Sprint(i), "name": fmt.Sprintf("Service %d", i), "mode": "snapshot", "observation": Object{"status": "up", "observedAt": nil, "fetchedAt": now, "changedAt": nil, "latencyMs": nil}, "recent": []any{}})
		sources = append(sources, source)
	}
	cache, err := s.app.subscriptionCacheDocument(ctx, subscription, Object{})
	if err != nil {
		t.Fatal(err)
	}
	for kind, value := range map[string]Object{"subscription": subscription, "subscription_config": config} {
		if err := s.app.store.put(ctx, kind, str(value, "id"), value); err != nil {
			t.Fatal(err)
		}
	}
	if err := s.app.store.mutate(ctx, func(tx *transaction) error {
		for index, raw := range sources {
			item := newSubscriptionItem(object(raw), subscription, true)
			if index < 25 {
				item = clone(mergeSubscriptionItem(item, object(raw), "v1", now))
			}
			if err := tx.put("subscription_item", str(item, "id"), item); err != nil {
				return err
			}
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	payload := Object{"parsed": Object{"items": sources, "issues": []any{}, "complete": true}, "cacheDocument": cache, "requests": 1, "failures": []any{}, "subscriptionId": subscription["id"], "expiresAt": now + 600}
	if err := s.app.store.put(ctx, "subscription_normalized", "resumed-payload", payload); err != nil {
		t.Fatal(err)
	}
	if err := s.app.store.put(ctx, "subscription_checkpoint", str(subscription, "id"), Object{"subscriptionId": subscription["id"], "syncRevision": "v1", "payloadId": "resumed-payload", "offset": 25, "expiresAt": now + 600}); err != nil {
		t.Fatal(err)
	}
	s.app.subscriptionClient = &http.Client{Transport: aiRoundTrip(func(*http.Request) (*http.Response, error) {
		t.Error("resume fetched the source again")
		return nil, fmt.Errorf("unexpected fetch")
	})}
	run, err := s.app.runSubscription(ctx, str(subscription, "id"), true)
	if err != nil || run["state"] != "ready" || integer(run, "updatedItems") != 1000 {
		t.Fatal(run, err)
	}
	items, err := s.app.subscriptionItems(ctx, str(subscription, "id"))
	if err != nil || len(items) != 1000 {
		t.Fatal(len(items), err)
	}
	for _, item := range items {
		if len(array(item["recent"])) != 1 {
			t.Fatal("history duplicated", item["sourceItemId"])
		}
	}
	if checkpoint, _ := s.app.store.get(ctx, "subscription_checkpoint", str(subscription, "id")); checkpoint != nil {
		t.Fatal("checkpoint not retired")
	}
}

func TestSubscriptionDescriptorConditionalUpdate(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	descriptor := subscriptionFixture(t, "json-website")
	calls := 0
	s.app.subscriptionClient = &http.Client{Transport: aiRoundTrip(func(request *http.Request) (*http.Response, error) {
		calls++
		if calls > 1 {
			if request.Header.Get("If-None-Match") != "version-one" {
				t.Error("conditional header missing")
			}
			return &http.Response{StatusCode: 304, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(""))}, nil
		}
		return &http.Response{StatusCode: 200, Header: http.Header{"Etag": []string{"version-one"}}, Body: io.NopCloser(strings.NewReader(encode(descriptor)))}, nil
	})}
	address := "https://status.example.com/descriptor.json"
	if _, err := s.app.cachedSubscriptionDescriptor(ctx, address, false); err != nil {
		t.Fatal(err)
	}
	if _, err := s.app.cachedSubscriptionDescriptor(ctx, address, false); err != nil {
		t.Fatal(err)
	}
	if calls != 1 {
		t.Fatal(calls)
	}
	cached, _ := s.app.store.get(ctx, "subscription_remote_file", address)
	cached["checkedAt"] = time.Now().Unix() - 86401
	if err := s.app.store.put(ctx, "subscription_remote_file", address, cached); err != nil {
		t.Fatal(err)
	}
	next, err := s.app.cachedSubscriptionDescriptor(ctx, address, false)
	if err != nil || encode(next) != encode(descriptor) || calls != 2 {
		t.Fatal(next, err, calls)
	}
}
