package polaris

import (
	"context"
	"testing"
	"time"
)

func TestAIHistoryScopesDailyRows(t *testing.T) {
	s := newTestServer(t)
	ctx := context.Background()
	date := time.Now().Add(-24 * time.Hour).UTC().Format("2006-01-02")
	for _, id := range []string{"model", "model-extra"} {
		if err := s.app.store.put(ctx, "ai_day", id+":"+date, Object{"id": id + ":" + date, "modelId": id, "date": date, "total": 7, "ok": 5}); err != nil {
			t.Fatal(err)
		}
	}
	old := time.Now().Add(-100 * 24 * time.Hour).UTC().Format("2006-01-02")
	if err := s.app.store.put(ctx, "ai_day", "model:"+old, Object{"modelId": "model", "date": old}); err != nil {
		t.Fatal(err)
	}
	history, err := s.app.aiHistory(ctx, "model", 7)
	if err != nil {
		t.Fatal(err)
	}
	days := history["days"].([]Object)
	if len(days) != 1 || days[0]["date"] != date || integer(days[0], "total") != 7 {
		t.Fatal(history)
	}
}
