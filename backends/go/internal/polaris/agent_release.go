package polaris

import (
	"context"
	"embed"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

//go:embed agent-release-repository.json
var agentReleaseConfig embed.FS
var releaseRepository = func() string {
	raw, err := agentReleaseConfig.ReadFile("agent-release-repository.json")
	if err != nil {
		panic(err)
	}
	var v struct {
		Repository string `json:"repository"`
	}
	if json.Unmarshal(raw, &v) != nil || !regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`).MatchString(v.Repository) {
		panic("invalid Agent release repository")
	}
	return v.Repository
}()
var releaseCache struct {
	sync.Mutex
	value     Object
	until     time.Time
	checkedAt time.Time
}

// 合并刷新请求；等待者拿到锁后重新检查五分钟缓存。
// Coalesce refreshes; waiters recheck the five-minute cache after acquiring the lock.
var releaseFetchLock sync.Mutex
var releaseRefreshRunning atomic.Bool

func refreshAgentRelease() {
	if !releaseRefreshRunning.CompareAndSwap(false, true) {
		return
	}
	go func() {
		defer releaseRefreshRunning.Store(false)
		_, _ = latestAgentRelease()
	}()
}

var releaseClient = &http.Client{Timeout: 10 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
	return http.ErrUseLastResponse
}}
var releaseManifestPattern = regexp.MustCompile(`^(v(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*))/manifest\.json$`)
var agentVersionPattern = regexp.MustCompile(`^\d+\.\d+\.\d+$`)

func agentReleaseURL(tag, file string) string {
	return "https://github.com/" + releaseRepository + "/releases/download/" + tag + "/" + file
}

func agentReleaseFailureReason(err error) string {
	switch err.Error() {
	case "github_timeout", "github_rate_limited", "release_not_found", "github_unavailable", "invalid_release_redirect", "release_response_too_large", "empty_release_response", "invalid_release_manifest":
		return err.Error()
	default:
		return "github_unavailable"
	}
}

func requestAgentManifest() (Object, string, error) {
	latest := "https://github.com/" + releaseRepository + "/releases/latest/download/manifest.json"
	base := "https://github.com/" + releaseRepository + "/releases/download/"
	next, _ := url.Parse(latest)
	tag := ""
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	for count := 0; count < 5; count++ {
		if next.Scheme != "https" || next.User != nil || next.Port() != "" || next.Fragment != "" {
			return nil, "", failure("invalid_release_redirect", 502)
		}
		if next.Hostname() == "github.com" {
			if count != 0 || next.String() != latest {
				match := releaseManifestPattern.FindStringSubmatch(strings.TrimPrefix(next.String(), base))
				if match == nil || tag != "" && tag != match[1] {
					return nil, "", failure("invalid_release_redirect", 502)
				}
				tag = match[1]
			}
		} else if next.Hostname() != "release-assets.githubusercontent.com" || tag == "" {
			return nil, "", failure("invalid_release_redirect", 502)
		}
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, next.String(), nil)
		if err != nil {
			return nil, "", failure("invalid_release_redirect", 502)
		}
		req.Header.Set("User-Agent", "Uptime-Polaris")
		req.Header.Set("Accept", "application/json")
		res, err := releaseClient.Do(req)
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
				return nil, "", failure("github_timeout", 502)
			}
			return nil, "", failure("github_unavailable", 502)
		}
		if res.StatusCode >= 300 && res.StatusCode < 400 {
			location := res.Header.Get("Location")
			res.Body.Close()
			if location == "" {
				return nil, "", failure("invalid_release_redirect", 502)
			}
			next, err = next.Parse(location)
			if err != nil {
				return nil, "", failure("invalid_release_redirect", 502)
			}
			continue
		}
		defer res.Body.Close()
		switch res.StatusCode {
		case http.StatusNotFound:
			return nil, "", failure("release_not_found", 501)
		case http.StatusForbidden, http.StatusTooManyRequests:
			return nil, "", failure("github_rate_limited", 502)
		}
		if res.StatusCode < 200 || res.StatusCode >= 300 {
			return nil, "", failure("github_unavailable", 502)
		}
		if tag == "" {
			return nil, "", failure("invalid_release_redirect", 502)
		}
		const limit = 65536
		if res.ContentLength > limit {
			return nil, "", failure("release_response_too_large", 502)
		}
		raw, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
		if err != nil {
			if errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
				return nil, "", failure("github_timeout", 502)
			}
			return nil, "", failure("github_unavailable", 502)
		}
		if len(raw) > limit {
			return nil, "", failure("release_response_too_large", 502)
		}
		manifest := Object{}
		if json.Unmarshal(raw, &manifest) != nil {
			return nil, "", failure("invalid_release_manifest", 502)
		}
		return manifest, tag, nil
	}
	return nil, "", failure("invalid_release_redirect", 502)
}

func latestAgentRelease() (Object, error) {
	return readAgentRelease(false)
}

func readAgentRelease(refresh bool) (Object, error) {
	releaseFetchLock.Lock()
	defer releaseFetchLock.Unlock()
	releaseCache.Lock()
	if time.Now().Before(releaseCache.until) && (!refresh || time.Since(releaseCache.checkedAt) < time.Minute) {
		value := releaseCache.value
		releaseCache.Unlock()
		return value, nil
	}
	releaseCache.Unlock()
	manifest, tag, err := requestAgentManifest()
	if err != nil {
		return nil, err
	}
	version := strings.TrimPrefix(tag, "v")
	if str(manifest, "tag") != tag || str(manifest, "version") != version || str(manifest, "repository") != releaseRepository || len(array(manifest["platforms"])) == 0 {
		return nil, failure("invalid_release_manifest", 502)
	}
	seen := map[string]bool{}
	for _, item := range array(manifest["platforms"]) {
		e := object(item)
		key := str(e, "key")
		file := str(e, "file")
		ext := ""
		if key == "windows-x86_64" {
			ext = ".exe"
		}
		size, ok := e["size"].(float64)
		if !ok || size != math.Trunc(size) || !contains([]string{"linux-x86_64", "linux-aarch64", "windows-x86_64", "darwin-x86_64", "darwin-aarch64"}, key) || seen[key] || str(e, "version") != version || file != "polaris-agent-"+version+"-"+key+ext || size <= 0 || size > 64<<20 || !regexp.MustCompile(`^[a-f0-9]{64}$`).MatchString(str(e, "sha256")) {
			return nil, failure("invalid_release_manifest", 502)
		}
		seen[key] = true
	}
	releaseCache.Lock()
	releaseCache.value = manifest
	releaseCache.until = time.Now().Add(5 * time.Minute)
	releaseCache.checkedAt = time.Now()
	releaseCache.Unlock()
	return manifest, nil
}

func agentVersionState(actual, latest string) string {
	if actual == "" {
		return "not_reported"
	}
	if !agentVersionPattern.MatchString(actual) || !agentVersionPattern.MatchString(latest) {
		return "unknown"
	}
	current, target := strings.Split(actual, "."), strings.Split(latest, ".")
	var left, right [3]uint64
	for index := range left {
		var err error
		left[index], err = strconv.ParseUint(current[index], 10, 53)
		if err != nil {
			return "unknown"
		}
		right[index], err = strconv.ParseUint(target[index], 10, 53)
		if err != nil {
			return "unknown"
		}
	}
	for index := range left {
		if left[index] < right[index] {
			return "behind"
		}
		if left[index] > right[index] {
			return "current"
		}
	}
	return "current"
}

func cachedAgentManifest() Object {
	releaseCache.Lock()
	defer releaseCache.Unlock()
	if time.Now().Before(releaseCache.until) {
		return releaseCache.value
	}
	return nil
}
