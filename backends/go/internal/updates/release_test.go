package updates

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func releaseFixture(t *testing.T, payload []byte) (*Releases, Release, *atomic.Bool) {
	t.Helper()
	bad := &atomic.Bool{}
	release := Release{Tag: "v1.1.0"}
	for _, osName := range []string{"linux", "darwin", "windows"} {
		for _, arch := range []string{"amd64", "arm64"} {
			release.Assets = append(release.Assets, struct {
				Name string `json:"name"`
			}{assetName(release.Tag, osName, arch)})
		}
	}
	release.Assets = append(release.Assets, struct {
		Name string `json:"name"`
	}{"SHA256SUMS.txt"})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case strings.Contains(r.URL.Path, "/repos/"):
			json.NewEncoder(w).Encode([]Release{release, {Tag: "v2.0.0-rc1", Prerelease: true}, {Tag: "v3.0.0", Draft: true}})
		case strings.HasSuffix(r.URL.Path, "polaris-update.json"):
			json.NewEncoder(w).Encode(Info{"1.1.0", Protocol, Storage})
		case strings.HasSuffix(r.URL.Path, "SHA256SUMS.txt"):
			sum := sha256.Sum256(payload)
			if bad.Load() {
				sum = [32]byte{}
			}
			for _, asset := range release.Assets {
				fmt.Fprintf(w, "%x  %s\n", sum, asset.Name)
			}
		default:
			w.Write(payload)
		}
	}))
	t.Cleanup(server.Close)
	return &Releases{Client: server.Client(), Repository: "test/project", API: server.URL, Downloads: server.URL}, release, bad
}
func TestReleaseSelectionAndSixPlatformAssets(t *testing.T) {
	source, release, bad := releaseFixture(t, []byte("verified release"))
	latest, e := source.Latest(context.Background())
	if e != nil || latest.Tag != release.Tag {
		t.Fatalf("latest=%v err=%v", latest, e)
	}
	for _, osName := range []string{"linux", "darwin", "windows"} {
		for _, arch := range []string{"amd64", "arm64"} {
			t.Run(osName+"/"+arch, func(t *testing.T) {
				path := filepath.Join(t.TempDir(), "binary")
				if e := source.Download(context.Background(), release, osName, arch, path); e != nil {
					t.Fatal(e)
				}
				raw, _ := os.ReadFile(path)
				if string(raw) != "verified release" {
					t.Fatal("download changed")
				}
			})
		}
	}
	bad.Store(true)
	path := filepath.Join(t.TempDir(), "binary")
	if e = source.Download(context.Background(), release, "windows", "arm64", path); e == nil || e.Error() != "update_checksum_mismatch" {
		t.Fatal(e)
	}
	if _, e = os.Stat(path); !os.IsNotExist(e) {
		t.Fatal("invalid download retained")
	}
	if !newer("v100000000000000000000.0.0", "v9.1.0") || newer("v1.0.0", "1.0.0") || newer("v2.0.0-beta", "1.0.0") {
		t.Fatal("version ordering")
	}
}
func TestControllerAuthPolicyAndAutomaticFailureQuarantine(t *testing.T) {
	source, _, _ := releaseFixture(t, nil)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var attempts atomic.Int32
	dir := t.TempDir()
	c, e := NewController(ctx, dir, "secret", State{Current: "1.0.0", Supported: true}, source, func(context.Context, Release, func(string)) error {
		attempts.Add(1)
		return fmt.Errorf("update_rolled_back")
	})
	if e != nil {
		t.Fatal(e)
	}
	request := func(method, path, body, auth string) int {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Authorization", auth)
		c.Handler().ServeHTTP(w, r)
		return w.Code
	}
	if request("POST", "/apply", `{"version":"v1.1.0"}`, "") != 401 {
		t.Fatal("unauthenticated update accepted")
	}
	if c.Snapshot().Automatic {
		t.Fatal("automatic enabled by default")
	}
	if request("PUT", "/policy", `{"automatic":true}`, "Bearer secret") != 200 {
		t.Fatal("policy failed")
	}
	if e = c.begin("check", ""); e != nil {
		t.Fatal(e)
	}
	c.Wait()
	if attempts.Load() != 0 {
		t.Fatal("check-only request installed an update")
	}
	if e = c.begin("automatic", ""); e != nil {
		t.Fatal(e)
	}
	c.Wait()
	if attempts.Load() != 1 || c.Snapshot().Phase != "rolled_back" {
		t.Fatalf("attempts=%d state=%+v", attempts.Load(), c.Snapshot())
	}
	restored, e := NewController(ctx, dir, "secret", State{Current: "1.0.0", Supported: true}, source, c.apply)
	if e != nil {
		t.Fatal(e)
	}
	if !restored.Snapshot().Automatic {
		t.Fatal("policy lost")
	}
	if e = restored.begin("automatic", ""); e != nil {
		t.Fatal(e)
	}
	restored.Wait()
	if attempts.Load() != 1 {
		t.Fatal("failed version retried automatically")
	}
	if e = restored.begin("apply", "v1.1.0"); e != nil {
		t.Fatal(e)
	}
	restored.Wait()
	if attempts.Load() != 2 {
		t.Fatal("manual retry blocked")
	}
}
func TestControllerSerializesUpdatesAndRejectsChangedVersion(t *testing.T) {
	source, _, _ := releaseFixture(t, nil)
	gate := make(chan struct{})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	c, e := NewController(ctx, t.TempDir(), "secret", State{Current: "1.0.0", Supported: true}, source, func(context.Context, Release, func(string)) error { <-gate; return nil })
	if e != nil {
		t.Fatal(e)
	}
	if e = c.begin("apply", "v1.1.0"); e != nil {
		t.Fatal(e)
	}
	if e = c.begin("apply", "v1.1.0"); e == nil || e.Error() != "update_busy" {
		t.Fatal("concurrent update accepted")
	}
	close(gate)
	c.Wait()
	if c.Snapshot().Current != "v1.1.0" || c.Snapshot().Phase != "complete" {
		t.Fatalf("state=%+v", c.Snapshot())
	}
	if e = c.begin("apply", "v1.2.0"); e != nil {
		t.Fatal(e)
	}
	c.Wait()
	if c.Snapshot().Error != "update_version_changed" {
		t.Fatal("stale version accepted")
	}
}
func TestHealthRequiresExactVersionAndValidDatabase(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": "1.0.0"})
	}))
	defer server.Close()
	if e := waitHealth(context.Background(), server.URL, "v1.0.0", time.Second); e != nil {
		t.Fatal(e)
	}
	if e := waitHealth(context.Background(), server.URL, "v1.1.0", 20*time.Millisecond); e == nil {
		t.Fatal("wrong version accepted")
	}
}
