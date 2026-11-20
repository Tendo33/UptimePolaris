package polaris

import (
	"context"
	"time"
)

func subscriptionHealth(row Object) string {
	if row["archivedAt"] != nil {
		return "archived"
	}
	if !boolean(row["enabled"]) {
		return "paused"
	}
	return str(object(row["runtime"]), "health")
}

func (s *Store) subscriptionSelectedCounts(ctx context.Context) (map[string]int64, error) {
	query := "SELECT " + s.jsonField("subscriptionId") + ",COUNT(*) FROM polaris_documents WHERE kind='subscription_item' AND CAST(" + s.jsonField("selected") + " AS TEXT) IN ('1','true') AND " + s.jsonField("removedAt") + " IS NULL GROUP BY " + s.jsonField("subscriptionId")
	rows, err := s.db.QueryContext(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	counts := map[string]int64{}
	for rows.Next() {
		var id string
		var count int64
		if err := rows.Scan(&id, &count); err != nil {
			return nil, err
		}
		counts[id] = count
	}
	return counts, rows.Err()
}

func (a *App) subscriptionStatusView(ctx context.Context, row Object) (Object, error) {
	entries, err := a.store.subscriptionItemIndex(ctx, str(row, "id"), false)
	if err != nil {
		return nil, err
	}
	counts := Object{}
	selected := int64(0)
	for _, item := range entries {
		if boolean(item["selected"]) && item["removedAt"] == nil {
			status := str(subscriptionItemView(item, row, time.Now().Unix()), "displayStatus")
			counts[status] = integer(counts, status) + 1
			selected++
		}
	}
	row["statusCounts"] = counts
	object(row["runtime"])["selectedCount"] = selected
	return row, nil
}
