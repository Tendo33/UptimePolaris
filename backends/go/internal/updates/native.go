package updates

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const Protocol = 1

// Bump when older binaries cannot read newly written data.
const Storage = "documents-v1"

type Info struct {
	Version  string `json:"version"`
	Protocol int    `json:"protocol"`
	Storage  string `json:"storage"`
}

func BuildInfo() Info { return Info{Version, Protocol, Storage} }

type nativeSlot struct {
	Path    string `json:"path"`
	Version string `json:"version"`
}
type nativeJournal struct {
	Active   nativeSlot  `json:"active"`
	Previous *nativeSlot `json:"previous,omitempty"`
	Pending  bool        `json:"pending"`
}
type child struct {
	cmd     *exec.Cmd
	input   io.WriteCloser
	done    chan struct{}
	err     error
	address string
}
type native struct {
	mu       sync.Mutex
	dir      string
	args     []string
	env      []string
	running  *child
	journal  nativeJournal
	releases *Releases
}

func Managed() bool { return os.Getenv("POLARIS_MANAGED") == "1" }
func ChildReady(address string) {
	if Managed() {
		fmt.Fprintln(os.Stdout, "POLARIS_READY "+address)
	}
}
func WatchParent(stop context.CancelFunc) {
	if Managed() {
		go func() {
			scanner := bufio.NewScanner(os.Stdin)
			for scanner.Scan() {
				if scanner.Text() == "stop" {
					break
				}
			}
			stop()
		}()
	}
}

func LockManagedData(ctx context.Context, dataDir string) (func(), error) {
	if !Managed() {
		return func() {}, nil
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	for {
		unlock, e := acquireLock(filepath.Join(dataDir, "updates", "child.lock"))
		if e == nil {
			return unlock, nil
		}
		select {
		case <-ctx.Done():
			return nil, errors.New("server_data_directory_busy")
		case <-ticker.C:
		}
	}
}

func LockController(dir string) (func(), error) {
	return acquireLock(filepath.Join(dir, "process.lock"))
}
func (n *native) launch(ctx context.Context, slot nativeSlot) (*child, error) {
	cmd := exec.Command(slot.Path, n.args...)
	cmd.Env = n.env
	cmd.Stderr = os.Stderr
	input, e := cmd.StdinPipe()
	if e != nil {
		return nil, e
	}
	output, e := cmd.StdoutPipe()
	if e != nil {
		input.Close()
		return nil, e
	}
	c := &child{cmd: cmd, input: input, done: make(chan struct{})}
	ready := make(chan string, 1)
	if e = cmd.Start(); e != nil {
		input.Close()
		return nil, e
	}
	go func() {
		scanner := bufio.NewScanner(output)
		for scanner.Scan() {
			line := scanner.Text()
			if strings.HasPrefix(line, "POLARIS_READY ") {
				select {
				case ready <- strings.TrimPrefix(line, "POLARIS_READY "):
				default:
				}
			} else {
				fmt.Fprintln(os.Stdout, line)
			}
		}
		c.err = cmd.Wait()
		close(c.done)
	}()
	timer := time.NewTimer(60 * time.Second)
	defer timer.Stop()
	select {
	case c.address = <-ready:
		if e = waitHealth(ctx, healthURL(c.address), slot.Version, 30*time.Second); e == nil {
			return c, nil
		}
	case <-c.done:
		return nil, errors.New("update_start_failed")
	case <-ctx.Done():
		e = ctx.Err()
	case <-timer.C:
		e = errors.New("update_start_timeout")
	}
	_ = c.stop()
	return nil, e
}
func healthURL(address string) string {
	host, port, e := net.SplitHostPort(address)
	if e != nil {
		return ""
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port) + "/api/public/health"
}
func waitHealth(ctx context.Context, address, version string, timeout time.Duration) error {
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	client := &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{DisableKeepAlives: true}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	for {
		req, e := http.NewRequestWithContext(ctx, "GET", address, nil)
		if e != nil {
			return errors.New("update_health_failed")
		}
		res, e := client.Do(req)
		if e == nil {
			var value struct {
				OK      bool   `json:"ok"`
				Version string `json:"version"`
			}
			e = json.NewDecoder(io.LimitReader(res.Body, 4096)).Decode(&value)
			res.Body.Close()
			if e == nil && res.StatusCode == 200 && value.OK && strings.TrimPrefix(value.Version, "v") == strings.TrimPrefix(version, "v") {
				return nil
			}
		}
		select {
		case <-ctx.Done():
			return errors.New("update_health_failed")
		case <-ticker.C:
		}
	}
}
func (c *child) stop() error {
	select {
	case <-c.done:
		return nil
	default:
	}
	_, _ = io.WriteString(c.input, "stop\n")
	_ = c.input.Close()
	timer := time.NewTimer(20 * time.Second)
	defer timer.Stop()
	select {
	case <-c.done:
		return nil
	case <-timer.C:
		if e := c.cmd.Process.Kill(); e != nil {
			return e
		}
		<-c.done
		return nil
	}
}
func (n *native) save() error { return WriteJSON(filepath.Join(n.dir, "native.json"), n.journal) }
func (n *native) apply(ctx context.Context, release Release, phase func(string)) error {
	phase("downloading")
	dir, e := os.MkdirTemp(n.dir, "version-"+strings.TrimPrefix(release.Tag, "v")+"-")
	if e != nil {
		return errors.New("update_storage_failed")
	}
	candidate := filepath.Join(dir, "polaris")
	if runtime.GOOS == "windows" {
		candidate += ".exe"
	}
	keep := false
	defer func() {
		if !keep {
			_ = os.Remove(candidate)
			_ = os.Remove(dir)
		}
	}()
	if e = n.releases.Download(ctx, release, runtime.GOOS, runtime.GOARCH, candidate); e != nil {
		return e
	}
	infoCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	raw, e := exec.CommandContext(infoCtx, candidate, "--update-info").Output()
	var info Info
	if e != nil || json.Unmarshal(raw, &info) != nil || info.Protocol != Protocol || info.Storage != Storage || strings.TrimPrefix(info.Version, "v") != strings.TrimPrefix(release.Tag, "v") {
		return errors.New("update_binary_invalid")
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	old := n.journal.Active
	n.journal.Previous = &old
	n.journal.Pending = true
	if n.save() != nil {
		return errors.New("update_storage_failed")
	}
	phase("restarting")
	if n.running.stop() != nil {
		return errors.New("update_stop_failed")
	}
	slot := nativeSlot{candidate, info.Version}
	started, e := n.launch(ctx, slot)
	if e == nil {
		n.running = started
		n.journal.Active = slot
		n.journal.Pending = false
		if n.save() == nil {
			keep = true
			return nil
		}
		_ = started.stop()
	}
	recoveryCtx, cancelRecovery := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancelRecovery()
	restored, recoveryErr := n.launch(recoveryCtx, old)
	if recoveryErr != nil {
		return errors.New("update_recovery_failed")
	}
	n.running = restored
	n.journal.Active = old
	n.journal.Pending = false
	if n.save() != nil {
		return errors.New("update_storage_failed")
	}
	return errors.New("update_rolled_back")
}
func RunNative(ctx context.Context, dataDir string, args []string) error {
	dir, e := filepath.Abs(filepath.Join(dataDir, "updates"))
	if e != nil {
		return e
	}
	if e = os.MkdirAll(dir, 0700); e != nil {
		return e
	}
	lock, e := LockController(dir)
	if e != nil {
		return e
	}
	defer lock()
	executable, e := os.Executable()
	if e != nil {
		return e
	}
	n := &native{dir: dir, args: args, releases: OfficialReleases(), journal: nativeJournal{Active: nativeSlot{executable, Version}}}
	raw, e := os.ReadFile(filepath.Join(dir, "native.json"))
	if e == nil {
		if json.Unmarshal(raw, &n.journal) != nil {
			return errors.New("update_state_invalid")
		}
		if n.journal.Pending && n.journal.Previous != nil {
			n.journal.Active = *n.journal.Previous
			n.journal.Pending = false
			if e = n.save(); e != nil {
				return e
			}
		}
	} else if !os.IsNotExist(e) {
		return e
	}
	if newer(Version, n.journal.Active.Version) {
		previous := n.journal.Active
		n.journal.Previous = &previous
		n.journal.Active = nativeSlot{executable, Version}
		n.journal.Pending = false
		if e = n.save(); e != nil {
			return e
		}
	}
	listener, e := net.Listen("tcp", "127.0.0.1:0")
	if e != nil {
		return e
	}
	defer listener.Close()
	token := Secret()
	for _, entry := range os.Environ() {
		key, _, _ := strings.Cut(entry, "=")
		if key != "POLARIS_MANAGED" && key != "POLARIS_UPDATER_URL" && key != "POLARIS_UPDATER_TOKEN" {
			n.env = append(n.env, entry)
		}
	}
	n.env = append(n.env, "POLARIS_MANAGED=1", "POLARIS_UPDATER_URL=http://"+listener.Addr().String(), "POLARIS_UPDATER_TOKEN="+token)
	controllerCtx, cancel := context.WithCancel(ctx)
	defer cancel()
	controller, e := NewController(controllerCtx, dir, token, State{Current: n.journal.Active.Version, Mode: "native", OS: runtime.GOOS, Arch: runtime.GOARCH, Supported: supported(runtime.GOOS, runtime.GOARCH) && stable.MatchString(n.journal.Active.Version)}, n.releases, n.apply)
	if e != nil {
		return e
	}
	server := &http.Server{Handler: controller.Handler(), ReadHeaderTimeout: 5 * time.Second}
	defer server.Close()
	go server.Serve(listener)
	n.running, e = n.launch(ctx, n.journal.Active)
	if e != nil {
		return e
	}
	controller.Start()
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			cancel()
			server.Close()
			controller.Wait()
			n.mu.Lock()
			e = n.running.stop()
			n.mu.Unlock()
			return e
		case <-ticker.C:
			n.mu.Lock()
			select {
			case <-n.running.done:
				e = errors.New("server_process_stopped")
			default:
				e = nil
			}
			n.mu.Unlock()
			if e != nil {
				cancel()
				controller.Wait()
				return e
			}
		}
	}
}
