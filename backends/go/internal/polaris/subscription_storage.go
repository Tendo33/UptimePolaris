package polaris

import (
	"context"
	"sort"
	"strings"
	"time"
)

func (s *Store) subscriptionDocuments(ctx context.Context, queryer documentQueryer, kind, id string, sourceIDs ...[]string) ([]Object, error) {
	query := "SELECT data FROM polaris_documents WHERE kind=? AND " + s.jsonField("subscriptionId") + "=?"
	args := []any{kind, id}
	if len(sourceIDs) > 0 {
		if len(sourceIDs[0]) == 0 {
			return []Object{}, nil
		}
		query += " AND " + s.jsonField("sourceItemId") + " IN (" + strings.TrimSuffix(strings.Repeat("?,", len(sourceIDs[0])), ",") + ")"
		for _, sourceID := range sourceIDs[0] {
			args = append(args, sourceID)
		}
	}
	rows, err := queryer.QueryContext(ctx, s.query(query+" ORDER BY id"), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		item, err := decodeObject(raw)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func sortSubscriptionItems(items []Object) {
	sort.SliceStable(items, func(i, j int) bool {
		a, b := items[i], items[j]
		if integer(a, "sortOrder") != integer(b, "sortOrder") {
			return integer(a, "sortOrder") < integer(b, "sortOrder")
		}
		name := func(row Object) string {
			if str(row, "localName") != "" {
				return str(row, "localName")
			}
			return str(row, "name")
		}
		if name(a) != name(b) {
			return name(a) < name(b)
		}
		return str(a, "id") < str(b, "id")
	})
}

func (s *Store) subscriptionItemIndex(ctx context.Context, id string, publicOnly bool) ([]Object, error) {
	projection := "json_remove(data,'$.days','$.recent')"
	if s.postgres {
		projection = "(data::jsonb-'days'-'recent')::text"
	}
	query := "SELECT " + projection + " FROM polaris_documents WHERE kind='subscription_item'"
	args := []any{}
	if id != "" {
		query += " AND " + s.jsonField("subscriptionId") + "=?"
		args = append(args, id)
	}
	if publicOnly {
		query += " AND CAST(" + s.jsonField("selected") + " AS TEXT) IN ('1','true') AND CAST(" + s.jsonField("isPublic") + " AS TEXT) IN ('1','true')"
	}
	rows, err := s.db.QueryContext(ctx, s.query(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	items := []Object{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		item, err := decodeObject(raw)
		if err != nil {
			return nil, err
		}
		items = append(items, item)
	}
	return items, rows.Err()
}

func (s *Store) subscriptionItemsByIndex(ctx context.Context, index []Object) ([]Object, error) {
	if len(index) == 0 {
		return []Object{}, nil
	}
	args := []any{}
	for _, item := range index {
		args = append(args, item["id"])
	}
	query := "SELECT data FROM polaris_documents WHERE kind='subscription_item' AND id IN (" + strings.TrimSuffix(strings.Repeat("?,", len(index)), ",") + ")"
	rows, err := s.db.QueryContext(ctx, s.query(query), args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	byID := map[string]Object{}
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, err
		}
		item, err := decodeObject(raw)
		if err != nil {
			return nil, err
		}
		byID[str(item, "id")] = item
	}
	items := []Object{}
	for _, item := range index {
		if full := byID[str(item, "id")]; full != nil {
			items = append(items, full)
		}
	}
	return items, rows.Err()
}

func (a *App) subscriptionRunView(ctx context.Context, run Object) Object {
	if run["state"] != "running" {
		return run
	}
	var owner string
	var expires int64
	err := a.store.db.QueryRowContext(ctx, a.store.query("SELECT owner,expires_at FROM polaris_leases WHERE id=?"), "subscription:"+str(run, "subscriptionId")).Scan(&owner, &expires)
	if err == nil && owner == str(run, "id") && expires > time.Now().Unix() {
		return run
	}
	view := clone(run)
	view["state"], view["phase"], view["finishedAt"] = "obsolete", "complete", time.Now().Unix()
	return view
}

func (s *Store) cleanupSubscriptions(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, s.query("DELETE FROM polaris_documents WHERE (kind,id) IN (SELECT kind,id FROM polaris_documents WHERE kind IN ('subscription_preview','subscription_run','subscription_create','subscription_remote_file','subscription_checkpoint','subscription_normalized') AND CAST(COALESCE("+s.jsonField("expiresAt")+",'0') AS BIGINT)>0 AND CAST("+s.jsonField("expiresAt")+" AS BIGINT)<=? ORDER BY updated_at LIMIT 500)"), time.Now().Unix())
	return err
}
