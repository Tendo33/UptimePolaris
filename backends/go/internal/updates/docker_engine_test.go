package updates

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

type localImageTransport struct{ http.RoundTripper }

func (t localImageTransport) RoundTrip(r *http.Request) (*http.Response, error) {
	if strings.HasSuffix(r.URL.Path, "/images/create") {
		return &http.Response{StatusCode: 200, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(`{"status":"local test image"}`))}, nil
	}
	return t.RoundTripper.RoundTrip(r)
}

func TestDockerEngineRecreateAndRollback(t *testing.T) {
	if os.Getenv("POLARIS_TEST_DOCKER") != "1" {
		t.Skip("set POLARIS_TEST_DOCKER=1 with a local Docker Engine")
	}
	if runtime.GOOS != "linux" {
		t.Fatal("Docker integration requires a Linux test runner")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Minute)
	defer cancel()
	run := func(args ...string) string {
		t.Helper()
		raw, e := exec.CommandContext(ctx, "docker", args...).CombinedOutput()
		if e != nil {
			t.Fatalf("docker %v: %s %v", args, raw, e)
		}
		return strings.TrimSpace(string(raw))
	}
	prefix := "polaris-update-test-" + strings.ToLower(Secret()[:12])
	image := prefix + "/app"
	dir := t.TempDir()
	for _, version := range []string{"1.0.0", "1.1.0"} {
		cmd := exec.CommandContext(ctx, "go", "build", "-ldflags", "-X github.com/XingLingQAQ/uptime/backends/go/internal/updates.Version="+version, "-o", filepath.Join(dir, "server"), "./testdata/server")
		cmd.Env = append(os.Environ(), "CGO_ENABLED=0")
		if raw, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("build fixture: %s %v", raw, e)
		}
		dockerfile := "FROM scratch\nCOPY server /server\nLABEL org.opencontainers.image.version=v" + version + " io.uptime-polaris.update-storage=" + Storage + "\nENTRYPOINT [\"/server\"]\n"
		if e := os.WriteFile(filepath.Join(dir, "Dockerfile"), []byte(dockerfile), 0600); e != nil {
			t.Fatal(e)
		}
		run("build", "-q", "-t", image+":v"+version, dir)
	}
	defer func() { _ = exec.Command("docker", "image", "rm", image+":v1.0.0", image+":v1.1.0").Run() }()
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "switch", true: "rollback"}[fail], func(t *testing.T) {
			name := prefix + map[bool]string{false: "-ok", true: "-fail"}[fail]
			network := name + "-network"
			volume := name + "-data"
			run("network", "create", network)
			run("volume", "create", volume)
			defer func() {
				_ = exec.Command("docker", "network", "rm", network).Run()
				_ = exec.Command("docker", "volume", "rm", volume).Run()
			}()
			listener, e := net.Listen("tcp", "127.0.0.1:0")
			if e != nil {
				t.Fatal(e)
			}
			binding := listener.Addr().String()
			listener.Close()
			args := []string{"run", "-d", "--name", name, "--network", network, "--network-alias", "polaris", "--restart", "unless-stopped", "-p", binding + ":8080", "-v", volume + ":/data", "-e", "UPDATE_TEST_ADDR=0.0.0.0:8080", "-e", "KEEP=retained", "--label", "custom=retained"}
			if fail {
				args = append(args, "-e", "UPDATE_TEST_FAIL=1.1.0")
			}
			args = append(args, image+":v1.0.0")
			oldID := run(args...)
			d := NewDocker("/var/run/docker.sock", name, image, "", t.TempDir())
			d.Client.Transport = localImageTransport{d.Client.Transport}
			if e := d.Negotiate(ctx); e != nil {
				t.Fatal(e)
			}
			defer func() {
				raw, _ := os.ReadFile(filepath.Join(d.Dir, "docker.json"))
				var j dockerJournal
				_ = json.Unmarshal(raw, &j)
				_ = exec.Command("docker", "rm", "-f", name).Run()
				_ = exec.Command("docker", "rm", "-f", oldID).Run()
				if j.Replacement != "" {
					_ = exec.Command("docker", "rm", "-f", j.Replacement).Run()
				}
			}()
			address := run("port", name, "8080/tcp")
			host, port, e := net.SplitHostPort(address)
			if e != nil {
				t.Fatal(e)
			}
			d.Health = "http://" + net.JoinHostPort(host, port) + "/api/public/health"
			if e = waitHealth(ctx, d.Health, "1.0.0", 10*time.Second); e != nil {
				t.Fatal(e)
			}
			e = d.Apply(ctx, Release{Tag: "v1.1.0"}, func(string) {})
			want := "1.1.0"
			if fail {
				want = "1.0.0"
				if e == nil || e.Error() != "update_rolled_back" {
					t.Log("remaining container:", run("inspect", name))
					t.Fatal(e)
				}
			} else if e != nil {
				t.Fatal(e)
			}
			if e = waitHealth(ctx, d.Health, want, 10*time.Second); e != nil {
				t.Fatal(e)
			}
			actual, e := d.inspect(ctx, name)
			if e != nil {
				t.Fatal(e)
			}
			if len(actual.Mounts) != 1 || actual.Mounts[0].Name != volume || len(actual.NetworkSettings.Networks) != 1 {
				t.Fatalf("configuration lost: %+v", actual)
			}
			env := actual.Config["Env"].([]any)
			found := false
			for _, value := range env {
				found = found || value == "KEEP=retained"
			}
			if !found || actual.Config["Labels"].(map[string]any)["custom"] != "retained" {
				t.Fatal("environment or labels lost")
			}
		})
	}
}
