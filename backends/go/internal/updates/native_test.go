package updates

import (
	"context"
	"encoding/json"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"testing"
)

func TestNativeProcessUpdateAndRollback(t *testing.T) {
	dir := t.TempDir()
	binaries := map[string]string{}
	for _, version := range []string{"1.0.0", "1.1.0"} {
		path := filepath.Join(dir, "polaris-"+version)
		if runtime.GOOS == "windows" {
			path += ".exe"
		}
		cmd := exec.Command("go", "build", "-ldflags", "-X github.com/XingLingQAQ/uptime/backends/go/internal/updates.Version="+version, "-o", path, "./testdata/server")
		if raw, e := cmd.CombinedOutput(); e != nil {
			t.Fatalf("fixture build: %s %v", raw, e)
		}
		binaries[version] = path
	}
	payload, e := os.ReadFile(binaries["1.1.0"])
	if e != nil {
		t.Fatal(e)
	}
	source, release, _ := releaseFixture(t, payload)
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "startup-failure"}[fail], func(t *testing.T) {
			listener, e := net.Listen("tcp", "127.0.0.1:0")
			if e != nil {
				t.Fatal(e)
			}
			address := listener.Addr().String()
			listener.Close()
			env := append(os.Environ(), "POLARIS_MANAGED=1", "UPDATE_TEST_ADDR="+address)
			if fail {
				env = append(env, "UPDATE_TEST_FAIL=1.1.0")
			}
			n := &native{dir: t.TempDir(), releases: source, env: env, journal: nativeJournal{Active: nativeSlot{binaries["1.0.0"], "1.0.0"}}}
			n.running, e = n.launch(context.Background(), n.journal.Active)
			if e != nil {
				t.Fatal(e)
			}
			defer func() { n.running.stop() }()
			e = n.apply(context.Background(), release, func(string) {})
			want := "1.1.0"
			if fail {
				want = "1.0.0"
				if e == nil || e.Error() != "update_rolled_back" {
					t.Fatalf("rollback err=%v", e)
				}
			} else if e != nil {
				t.Fatal(e)
			}
			if n.journal.Active.Version != want || n.journal.Pending {
				t.Fatalf("journal=%+v", n.journal)
			}
			raw, e := os.ReadFile(filepath.Join(n.dir, "native.json"))
			var persisted nativeJournal
			if e != nil || json.Unmarshal(raw, &persisted) != nil || persisted.Active.Version != want || persisted.Pending {
				t.Fatalf("persisted=%s %v", raw, e)
			}
			// EOF models a killed supervisor, including Windows without POSIX signals.
			n.running.input.Close()
			<-n.running.done
			n.running, e = n.launch(context.Background(), persisted.Active)
			if e != nil {
				t.Fatalf("restart: %v", e)
			}
		})
	}
}
