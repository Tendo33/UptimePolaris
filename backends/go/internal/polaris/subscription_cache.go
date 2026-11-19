package polaris

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/base64"
	"io"
)

func (a *App) subscriptionResponseCache(ctx context.Context, subscription Object) (Object, error) {
	row, err := a.store.get(ctx, "subscription_cache", str(subscription, "id"))
	if err != nil {
		return nil, err
	}
	if row == nil || row["configId"] != subscription["configId"] {
		return Object{}, nil
	}
	secret, err := a.decryptSubscription(ctx, Object{"id": "response:" + str(subscription, "id") + ":" + str(subscription, "configId"), "ciphertext": row["ciphertext"]})
	if err != nil {
		return nil, err
	}
	compressed, err := base64.StdEncoding.DecodeString(str(secret, "value"))
	if err != nil {
		return nil, subscriptionError("cache_invalid")
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed))
	if err != nil {
		return nil, subscriptionError("cache_invalid")
	}
	defer reader.Close()
	value, err := io.ReadAll(io.LimitReader(reader, 11<<20))
	if err != nil || len(value) >= 11<<20 {
		return nil, subscriptionError("cache_invalid")
	}
	return decodeObject(string(value))
}
func (a *App) subscriptionCacheDocument(ctx context.Context, subscription, cache Object) (Object, error) {
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write([]byte(encode(cache))); err != nil {
		return nil, err
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	ciphertext, err := a.encryptSubscription(ctx, Object{"value": base64.StdEncoding.EncodeToString(compressed.Bytes())}, "response:"+str(subscription, "id")+":"+str(subscription, "configId"))
	if err != nil {
		return nil, err
	}
	return Object{"id": subscription["id"], "subscriptionId": subscription["id"], "configId": subscription["configId"], "ciphertext": ciphertext}, nil
}
