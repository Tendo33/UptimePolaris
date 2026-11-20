package updates

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"
)

type State struct {
	Current   string `json:"current"`
	Latest    string `json:"latest,omitempty"`
	Mode      string `json:"mode"`
	OS        string `json:"os"`
	Arch      string `json:"arch"`
	Supported bool   `json:"supported"`
	Automatic bool   `json:"automatic"`
	Phase     string `json:"phase"`
	Error     string `json:"error,omitempty"`
	CheckedAt int64  `json:"checkedAt"`
	UpdatedAt int64  `json:"updatedAt"`
	Attempted string `json:"attempted,omitempty"`
}
type ApplyFunc func(context.Context, Release, func(string)) error
type Controller struct {
	mu       sync.Mutex
	state    State
	dir      string
	releases *Releases
	apply    ApplyFunc
	busy     bool
	ctx      context.Context
	wg       sync.WaitGroup
	token    string
}

func Secret() string {
	var raw [32]byte
	if _, e := rand.Read(raw[:]); e != nil {
		panic(e)
	}
	return hex.EncodeToString(raw[:])
}
func WriteJSON(path string, value any) error {
	raw, e := json.Marshal(value)
	if e != nil {
		return e
	}
	f, e := os.CreateTemp(filepath.Dir(path), ".update-*")
	if e != nil {
		return e
	}
	name := f.Name()
	defer os.Remove(name)
	if e = f.Chmod(0600); e == nil {
		_, e = f.Write(raw)
	}
	if e == nil {
		e = f.Sync()
	}
	ce := f.Close()
	if e != nil {
		return e
	}
	if ce != nil {
		return ce
	}
	return replaceFile(name, path)
}
func NewController(ctx context.Context, dir, token string, state State, release *Releases, apply ApplyFunc) (*Controller, error) {
	if e := os.MkdirAll(dir, 0700); e != nil {
		return nil, e
	}
	c := &Controller{dir: dir, token: token, state: state, releases: release, apply: apply, ctx: ctx}
	c.state.Phase = "idle"
	var policy struct {
		Automatic bool `json:"automatic"`
	}
	raw, e := os.ReadFile(filepath.Join(dir, "policy.json"))
	if e == nil {
		if json.Unmarshal(raw, &policy) != nil {
			return nil, errors.New("update_policy_invalid")
		}
	} else if !os.IsNotExist(e) {
		return nil, e
	}
	c.state.Automatic = policy.Automatic
	var previous State
	if raw, e := os.ReadFile(filepath.Join(dir, "result.json")); e == nil && json.Unmarshal(raw, &previous) == nil {
		c.state.Phase = previous.Phase
		c.state.Error = previous.Error
		c.state.UpdatedAt = previous.UpdatedAt
		c.state.Attempted = previous.Attempted
		c.state.Latest = previous.Latest
		c.state.CheckedAt = previous.CheckedAt
		if previous.Phase != "idle" && previous.Phase != "complete" && previous.Phase != "failed" && previous.Phase != "rolled_back" {
			c.state.Phase = "failed"
			c.state.Error = "update_interrupted"
		}
	}
	return c, nil
}
func (c *Controller) Snapshot() State { c.mu.Lock(); defer c.mu.Unlock(); return c.state }
func (c *Controller) phase(value string) {
	c.mu.Lock()
	c.state.Phase = value
	state := c.state
	c.mu.Unlock()
	_ = WriteJSON(filepath.Join(c.dir, "result.json"), state)
}
func (c *Controller) Start() {
	c.wg.Add(1)
	go func() {
		defer c.wg.Done()
		c.begin("automatic", "")
		ticker := time.NewTicker(6 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-c.ctx.Done():
				return
			case <-ticker.C:
				c.begin("automatic", "")
			}
		}
	}()
}
func (c *Controller) Wait() { c.wg.Wait() }
func (c *Controller) begin(action string, expected string) error {
	c.mu.Lock()
	if c.ctx.Err() != nil {
		c.mu.Unlock()
		return errors.New("update_updater_unavailable")
	}
	if c.busy {
		c.mu.Unlock()
		return errors.New("update_busy")
	}
	if !c.state.Supported {
		c.mu.Unlock()
		return errors.New("update_unsupported")
	}
	c.busy = true
	previousError, previousPhase := c.state.Error, c.state.Phase
	c.state.Phase = "checking"
	c.state.Error = ""
	c.wg.Add(1)
	c.mu.Unlock()
	go func() {
		defer c.wg.Done()
		defer func() { c.mu.Lock(); c.busy = false; c.mu.Unlock() }()
		ctx, cancel := context.WithTimeout(c.ctx, 15*time.Minute)
		defer cancel()
		release, e := c.releases.Latest(ctx)
		c.mu.Lock()
		c.state.CheckedAt = time.Now().Unix()
		if release != nil {
			c.state.Latest = release.Tag
		} else if e == nil {
			c.state.Latest = ""
		}
		current, automatic, attempted := c.state.Current, c.state.Automatic, c.state.Attempted
		c.mu.Unlock()
		if e == nil && action == "apply" && (release == nil || release.Tag != expected) {
			e = errors.New("update_version_changed")
		}
		if e == nil && release != nil && newer(release.Tag, current) && (action == "apply" || action == "automatic" && automatic && attempted != release.Tag) {
			c.mu.Lock()
			c.state.Attempted = release.Tag
			c.mu.Unlock()
			e = c.releases.Compatible(ctx, *release)
			if e == nil {
				e = c.apply(ctx, *release, c.phase)
			}
			if e == nil {
				c.mu.Lock()
				c.state.Current = release.Tag
				c.state.UpdatedAt = time.Now().Unix()
				c.mu.Unlock()
				c.phase("complete")
			}
		}
		if e != nil {
			slog.Error("update failed", "error", e, "mode", c.Snapshot().Mode)
			c.mu.Lock()
			c.state.Error = e.Error()
			c.mu.Unlock()
			if e.Error() == "update_rolled_back" {
				c.phase("rolled_back")
			} else {
				c.phase("failed")
			}
		} else if c.Snapshot().Phase == "checking" {
			if release != nil && release.Tag == attempted && previousError != "" && newer(release.Tag, current) {
				c.mu.Lock()
				c.state.Error = previousError
				c.mu.Unlock()
				c.phase(previousPhase)
			} else {
				c.phase("idle")
			}
		}
	}()
	return nil
}
func (c *Controller) Handler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Content-Type", "application/json")
		if subtle.ConstantTimeCompare([]byte(r.Header.Get("Authorization")), []byte("Bearer "+c.token)) != 1 {
			w.WriteHeader(401)
			io.WriteString(w, `{"error":"unauthorized"}`)
			return
		}
		var e error
		switch r.Method + " " + r.URL.Path {
		case "GET /status":
		case "POST /check":
			e = c.begin("check", "")
		case "POST /apply":
			var input struct {
				Version string `json:"version"`
			}
			if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input) != nil || !stable.MatchString(input.Version) {
				e = errors.New("invalid_request")
			} else {
				e = c.begin("apply", input.Version)
			}
		case "PUT /policy":
			var input struct {
				Automatic *bool `json:"automatic"`
			}
			if json.NewDecoder(io.LimitReader(r.Body, 4096)).Decode(&input) != nil || input.Automatic == nil {
				e = errors.New("invalid_request")
			} else {
				c.mu.Lock()
				e = WriteJSON(filepath.Join(c.dir, "policy.json"), input)
				if e != nil {
					e = errors.New("update_storage_failed")
				}
				if e == nil {
					c.state.Automatic = *input.Automatic
				}
				c.mu.Unlock()
			}
		default:
			w.WriteHeader(404)
			io.WriteString(w, `{"error":"not_found"}`)
			return
		}
		if e != nil {
			w.WriteHeader(409)
			json.NewEncoder(w).Encode(map[string]string{"error": e.Error()})
			return
		}
		json.NewEncoder(w).Encode(c.Snapshot())
	})
}
