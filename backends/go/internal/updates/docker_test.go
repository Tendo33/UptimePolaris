package updates

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

type dockerFixture struct {
	mu      sync.Mutex
	old     containerInfo
	next    *containerInfo
	created map[string]any
	fail    string
	events  []string
}

func newDockerFixture(t *testing.T, fail string) (*Docker, *dockerFixture) {
	t.Helper()
	f := &dockerFixture{fail: fail}
	json.Unmarshal([]byte(`{"Id":"old","Name":"/uptime-polaris","State":{"Running":true},"Config":{"Image":"example/polaris:v1.0.0","Env":["KEEP=yes"],"Labels":{"custom":"keep"}},"HostConfig":{"RestartPolicy":{"Name":"unless-stopped"},"NetworkMode":"example_default","PortBindings":{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"8080"}]},"Binds":["/srv/config:/config:ro"],"Memory":134217728},"Mounts":[{"Type":"volume","Name":"data-unchanged","Destination":"/data","RW":true}],"NetworkSettings":{"Networks":{"example_default":{"Aliases":["uptime-polaris","polaris"],"IPAMConfig":{"IPv4Address":"172.30.0.7"},"NetworkID":"discard","EndpointID":"discard"}}}}`), &f.old)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		defer f.mu.Unlock()
		path := strings.TrimPrefix(r.URL.Path, "/v1.52")
		f.events = append(f.events, r.Method+" "+path)
		switch {
		case path == "/version":
			json.NewEncoder(w).Encode(map[string]string{"ApiVersion": "1.52"})
		case path == "/health":
			version := "1.0.0"
			if f.next != nil && f.next.State.Running {
				version = "1.1.0"
				if f.fail == "health" {
					version = "wrong"
				}
			}
			json.NewEncoder(w).Encode(map[string]any{"ok": true, "version": version})
		case path == "/images/create":
			w.Write([]byte(`{"status":"pulled"}`))
		case strings.HasPrefix(path, "/images/"):
			version := "v1.0.0"
			if strings.Contains(path, "v1.1.0") {
				version = "v1.1.0"
			}
			json.NewEncoder(w).Encode(map[string]any{"OS": "linux", "Architecture": "arm64", "Config": map[string]any{"Labels": map[string]string{"org.opencontainers.image.version": version, "io.uptime-polaris.update-storage": Storage}}})
		case path == "/containers/create":
			if f.fail == "create" {
				w.WriteHeader(500)
				return
			}
			json.NewDecoder(r.Body).Decode(&f.created)
			next := &containerInfo{ID: "new", Name: "/uptime-polaris", Config: f.created}
			host, _ := f.created["HostConfig"].(map[string]any)
			next.HostConfig = host
			next.NetworkSettings.Networks = map[string]map[string]any{"example_default": {}}
			f.next = next
			json.NewEncoder(w).Encode(map[string]string{"Id": "new"})
		case strings.HasPrefix(path, "/networks/"):
			if strings.HasSuffix(path, "/disconnect") {
				f.old.NetworkSettings.Networks = map[string]map[string]any{}
			} else {
				var body struct{ EndpointConfig map[string]any }
				json.NewDecoder(r.Body).Decode(&body)
				f.old.NetworkSettings.Networks["example_default"] = body.EndpointConfig
			}
			w.WriteHeader(200)
		case strings.HasPrefix(path, "/containers/"):
			parts := strings.Split(strings.TrimPrefix(path, "/containers/"), "/")
			id := parts[0]
			var target *containerInfo
			if id == "old" || id == "uptime-polaris" && f.old.Name == "/uptime-polaris" {
				target = &f.old
			} else if f.next != nil && (id == "new" || id == "uptime-polaris") {
				target = f.next
			}
			if target == nil {
				w.WriteHeader(404)
				return
			}
			if r.Method == "DELETE" {
				f.next = nil
				w.WriteHeader(204)
				return
			}
			action := parts[1]
			switch action {
			case "json":
				json.NewEncoder(w).Encode(target)
			case "stop":
				target.State.Running = false
				w.WriteHeader(204)
			case "start":
				if target.ID == "new" && f.fail == "start" {
					w.WriteHeader(500)
					return
				}
				target.State.Running = true
				w.WriteHeader(204)
			case "rename":
				target.Name = "/" + r.URL.Query().Get("name")
				w.WriteHeader(204)
			case "update":
				var body map[string]any
				json.NewDecoder(r.Body).Decode(&body)
				target.HostConfig["RestartPolicy"] = body["RestartPolicy"]
				w.WriteHeader(200)
			default:
				t.Errorf("unexpected %s", path)
				w.WriteHeader(500)
			}
		default:
			t.Errorf("unexpected %s", path)
			w.WriteHeader(500)
		}
	}))
	t.Cleanup(server.Close)
	return &Docker{Client: server.Client(), Base: server.URL, Container: "uptime-polaris", Image: "example/polaris", Health: server.URL + "/health", Dir: t.TempDir()}, f
}
func TestDockerUpdatePreservesConfigurationAndRecoversFailures(t *testing.T) {
	for _, fail := range []string{"", "create", "start", "health"} {
		t.Run("failure="+fail, func(t *testing.T) {
			d, f := newDockerFixture(t, fail)
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			if e := d.Negotiate(ctx); e != nil {
				t.Fatal(e)
			}
			e := d.Apply(ctx, Release{Tag: "v1.1.0"}, func(string) {})
			f.mu.Lock()
			defer f.mu.Unlock()
			if fail != "" {
				if e == nil || e.Error() != "update_rolled_back" {
					t.Fatalf("err=%v events=%v", e, f.events)
				}
				if !f.old.State.Running || f.old.Name != "/uptime-polaris" || f.next != nil || f.old.HostConfig["RestartPolicy"].(map[string]any)["Name"] != "unless-stopped" {
					t.Fatalf("old not restored: %+v", f.old)
				}
				if len(f.old.NetworkSettings.Networks) != 1 {
					t.Fatal("network not restored")
				}
				return
			}
			if e != nil {
				t.Fatal(e)
			}
			if f.old.State.Running || f.next == nil || !f.next.State.Running {
				t.Fatal("container switch failed")
			}
			host := f.created["HostConfig"].(map[string]any)
			mounts := host["Mounts"].([]any)
			mount := mounts[0].(map[string]any)
			if mount["Source"] != "data-unchanged" || mount["Target"] != "/data" || host["Memory"] != float64(134217728) {
				t.Fatal("mount or resources changed")
			}
			if f.created["Env"].([]any)[0] != "KEEP=yes" || f.created["Labels"].(map[string]any)["custom"] != "keep" {
				t.Fatal("environment or labels lost")
			}
			endpoint := f.created["NetworkingConfig"].(map[string]any)["EndpointsConfig"].(map[string]any)["example_default"].(map[string]any)
			if _, ok := endpoint["EndpointID"]; ok {
				t.Fatal("runtime endpoint copied")
			}
			if endpoint["IPAMConfig"].(map[string]any)["IPv4Address"] != "172.30.0.7" {
				t.Fatal("static IP lost")
			}
		})
	}
}
func TestDockerInterruptedReplacementRecovery(t *testing.T) {
	d, f := newDockerFixture(t, "")
	if e := d.Negotiate(context.Background()); e != nil {
		t.Fatal(e)
	}
	old, e := d.inspect(context.Background(), "old")
	if e != nil {
		t.Fatal(e)
	}
	j := dockerJournal{Old: old, Backup: "uptime-polaris-backup", Pending: true}
	f.old.Name = "/" + j.Backup
	f.old.State.Running = false
	f.old.NetworkSettings.Networks = map[string]map[string]any{}
	f.next = &containerInfo{ID: "new", Name: "/uptime-polaris", Config: map[string]any{"Labels": map[string]any{"io.uptime-polaris.update-backup": j.Backup}}}
	f.next.State.Running = true
	if e = WriteJSON(d.Dir+"/docker.json", j); e != nil {
		t.Fatal(e)
	}
	if e = d.Recover(context.Background()); e != nil {
		t.Fatal(e)
	}
	if !f.old.State.Running || f.next != nil || f.old.Name != "/uptime-polaris" {
		t.Fatal("interrupted operation not restored")
	}
}
