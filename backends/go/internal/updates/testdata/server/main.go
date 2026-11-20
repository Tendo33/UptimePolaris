package main

import (
	"context"
	"encoding/json"
	"github.com/XingLingQAQ/uptime/backends/go/internal/updates"
	"net"
	"net/http"
	"os"
)

func main() {
	if len(os.Args) == 2 && os.Args[1] == "--update-info" {
		json.NewEncoder(os.Stdout).Encode(updates.BuildInfo())
		return
	}
	if os.Getenv("UPDATE_TEST_FAIL") == updates.Version {
		os.Exit(1)
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	updates.WatchParent(cancel)
	listener, e := net.Listen("tcp", os.Getenv("UPDATE_TEST_ADDR"))
	if e != nil {
		os.Exit(2)
	}
	server := &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": updates.Version})
	})}
	go func() { <-ctx.Done(); server.Close() }()
	updates.ChildReady(listener.Addr().String())
	server.Serve(listener)
}
