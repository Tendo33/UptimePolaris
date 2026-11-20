package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/XingLingQAQ/uptime/backends/go/internal/updates"
)

func main() {
	if e := run(); e != nil {
		slog.Error("updater stopped", "error", e)
		os.Exit(1)
	}
}
func env(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
func run() error {
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()
	dir := env("POLARIS_UPDATE_DATA_DIR", "/updates")
	if e := os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	unlock, e := updates.LockController(dir)
	if e != nil {
		return e
	}
	defer unlock()
	raw, e := os.ReadFile(env("POLARIS_UPDATER_TOKEN_FILE", "/run/secrets/updater-token"))
	if e != nil {
		return e
	}
	token := strings.TrimSpace(string(raw))
	if len(token) < 32 {
		return fmt.Errorf("updater token must contain at least 32 characters")
	}
	docker := updates.NewDocker(env("POLARIS_DOCKER_SOCKET", "/var/run/docker.sock"), env("POLARIS_UPDATE_CONTAINER", "uptime-polaris"), env("POLARIS_UPDATE_IMAGE", updates.ImageRepository), env("POLARIS_UPDATE_HEALTH_URL", "http://uptime-polaris:8080/api/public/health"), dir)
	startup, cancelStartup := context.WithTimeout(ctx, 90*time.Second)
	defer cancelStartup()
	if e = docker.Negotiate(startup); e != nil {
		return e
	}
	if e = docker.Recover(startup); e != nil {
		return e
	}
	version, arch, e := docker.Current(startup)
	if e != nil {
		return e
	}
	controller, e := updates.NewController(ctx, dir, token, updates.State{Current: version, Mode: "docker", OS: "linux", Arch: arch, Supported: true}, updates.OfficialReleases(), docker.Apply)
	if e != nil {
		return e
	}
	server := &http.Server{Addr: env("POLARIS_UPDATER_ADDR", "0.0.0.0:8091"), Handler: controller.Handler(), ReadHeaderTimeout: 5 * time.Second}
	controller.Start()
	go func() { <-ctx.Done(); _ = server.Close() }()
	e = server.ListenAndServe()
	cancel()
	controller.Wait()
	if e == http.ErrServerClosed {
		return nil
	}
	return e
}
