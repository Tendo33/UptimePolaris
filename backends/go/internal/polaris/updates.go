package polaris

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"runtime"
	"strings"
	"time"

	"github.com/XingLingQAQ/uptime/backends/go/internal/updates"
)

func (a *App) updateRoutes() {
	for _, route := range []struct{ pattern, path string }{{"GET /api/admin/updates", "/status"}, {"POST /api/admin/updates/check", "/check"}, {"POST /api/admin/updates/apply", "/apply"}, {"PUT /api/admin/updates/policy", "/policy"}} {
		a.route(route.pattern, false, func(w http.ResponseWriter, r *http.Request) error {
			mode := a.config.Deployment
			if mode == "" {
				mode = "native"
			}
			if a.config.UpdaterURL == "" || a.config.UpdaterToken == "" {
				if r.Method != "GET" {
					return failure("update_updater_unavailable", 503)
				}
				respond(w, 200, updates.State{Current: updates.Version, Mode: mode, OS: runtime.GOOS, Arch: runtime.GOARCH, Phase: "idle", Error: "update_updater_unavailable"})
				return nil
			}
			raw, e := io.ReadAll(io.LimitReader(r.Body, 4097))
			if e != nil || len(raw) > 4096 {
				return failure("invalid_request", 400)
			}
			ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
			defer cancel()
			req, e := http.NewRequestWithContext(ctx, r.Method, strings.TrimRight(a.config.UpdaterURL, "/")+route.path, bytes.NewReader(raw))
			if e != nil {
				return failure("update_updater_unavailable", 503)
			}
			req.Header.Set("Authorization", "Bearer "+a.config.UpdaterToken)
			req.Header.Set("Content-Type", "application/json")
			client := &http.Client{Timeout: 5 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
			res, e := client.Do(req)
			if e != nil {
				return failure("update_updater_unavailable", 503)
			}
			defer res.Body.Close()
			body, e := io.ReadAll(io.LimitReader(res.Body, 16385))
			if e != nil || len(body) > 16384 {
				return failure("update_updater_unavailable", 503)
			}
			if res.StatusCode != 200 {
				var problem struct {
					Error string `json:"error"`
				}
				if json.Unmarshal(body, &problem) == nil && strings.HasPrefix(problem.Error, "update_") {
					return failure(problem.Error, 409)
				}
				return failure("update_updater_unavailable", 503)
			}
			var state updates.State
			if json.Unmarshal(body, &state) != nil {
				return failure("update_updater_unavailable", 503)
			}
			state.Current = updates.Version
			respond(w, 200, state)
			return nil
		})
	}
}
