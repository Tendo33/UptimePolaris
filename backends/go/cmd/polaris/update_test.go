package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
	"time"
)

func TestReleaseSupervisorParentExitAndRestart(t *testing.T) {
	dir := t.TempDir()
	binary := filepath.Join(dir, "polaris")
	if runtime.GOOS == "windows" {
		binary += ".exe"
	}
	build := exec.Command("go", "build", "-ldflags", "-X github.com/XingLingQAQ/uptime/backends/go/internal/updates.Version=1.0.0", "-o", binary, ".")
	if raw, e := build.CombinedOutput(); e != nil {
		t.Fatalf("build: %s %v", raw, e)
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		t.Fatal(e)
	}
	address := listener.Addr().String()
	listener.Close()
	data := filepath.Join(dir, "data")
	start := func() *exec.Cmd {
		cmd := exec.Command(binary, "--addr", address, "--data-dir", data)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "POLARIS_SETUP_KEY=supervisor-test-only")
		if e := cmd.Start(); e != nil {
			t.Fatal(e)
		}
		t.Cleanup(func() { _ = cmd.Process.Kill() })
		return cmd
	}
	health := func() bool {
		client := &http.Client{Timeout: 250 * time.Millisecond}
		res, e := client.Get("http://" + address + "/api/public/health")
		if e != nil {
			return false
		}
		defer res.Body.Close()
		var body struct {
			OK      bool
			Version string
		}
		return json.NewDecoder(res.Body).Decode(&body) == nil && body.OK && body.Version == "1.0.0"
	}
	wait := func(want bool) {
		t.Helper()
		ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
		defer cancel()
		for health() != want {
			select {
			case <-ctx.Done():
				t.Fatal(fmt.Sprintf("health did not become %v", want))
			case <-time.After(50 * time.Millisecond):
			}
		}
	}
	first := start()
	wait(true)
	if e = first.Process.Kill(); e != nil {
		t.Fatal(e)
	}
	_ = first.Wait()
	wait(false)
	second := start()
	wait(true)
	if e = second.Process.Kill(); e != nil {
		t.Fatal(e)
	}
	_ = second.Wait()
	wait(false)
}
