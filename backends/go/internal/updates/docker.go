package updates

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"
)

type Docker struct {
	Client    *http.Client
	Base      string
	api       string
	Container string
	Image     string
	Health    string
	Dir       string
}
type containerInfo struct {
	ID         string `json:"Id"`
	Image      string
	Name       string
	Config     map[string]any
	HostConfig map[string]any
	Mounts     []struct {
		Type, Name, Source, Destination string
		RW                              bool
	}
	NetworkSettings struct {
		Networks map[string]map[string]any
		Ports    map[string]any
	}
	State struct{ Running bool }
}
type dockerJournal struct {
	Old         containerInfo `json:"old"`
	Replacement string        `json:"replacement"`
	Backup      string        `json:"backup"`
	Pending     bool          `json:"pending"`
}

func NewDocker(socket, container, image, health, dir string) *Docker {
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	return &Docker{Client: &http.Client{Transport: transport}, Base: "http://docker", Container: container, Image: image, Health: health, Dir: dir}
}
func (d *Docker) request(ctx context.Context, method, path string, input, output any) error {
	var raw []byte
	var e error
	if input != nil {
		raw, e = json.Marshal(input)
		if e != nil {
			return e
		}
	}
	req, e := http.NewRequestWithContext(ctx, method, d.Base+d.api+path, bytes.NewReader(raw))
	if e != nil {
		return e
	}
	req.Header.Set("Content-Type", "application/json")
	res, e := d.Client.Do(req)
	if e != nil {
		return errors.New("update_docker_unavailable")
	}
	defer res.Body.Close()
	if res.StatusCode < 200 || res.StatusCode >= 300 {
		return fmt.Errorf("update_docker_request_failed_%d", res.StatusCode)
	}
	if output != nil {
		if json.NewDecoder(io.LimitReader(res.Body, 8<<20)).Decode(output) != nil {
			return errors.New("update_docker_response_invalid")
		}
	}
	return nil
}
func (d *Docker) Negotiate(ctx context.Context) error {
	var info struct {
		APIVersion string `json:"ApiVersion"`
	}
	if e := d.request(ctx, "GET", "/version", nil, &info); e != nil {
		return e
	}
	if !regexpAPIVersion(info.APIVersion) {
		return errors.New("update_docker_response_invalid")
	}
	d.api = "/v" + info.APIVersion
	return nil
}
func regexpAPIVersion(value string) bool {
	if !strings.HasPrefix(value, "1.") {
		return false
	}
	for _, r := range value[2:] {
		if r < '0' || r > '9' {
			return false
		}
	}
	return len(value) > 2 && len(value) < 8
}
func (d *Docker) inspect(ctx context.Context, id string) (containerInfo, error) {
	var info containerInfo
	e := d.request(ctx, "GET", "/containers/"+url.PathEscape(id)+"/json", nil, &info)
	return info, e
}
func (d *Docker) Current(ctx context.Context) (string, string, error) {
	info, e := d.inspect(ctx, d.Container)
	if e != nil {
		return "", "", e
	}
	var image struct {
		Architecture string
		OS           string
		Config       struct{ Labels map[string]string }
	}
	imageID := info.Image
	if imageID == "" {
		imageID, _ = info.Config["Image"].(string)
	}
	if e = d.request(ctx, "GET", "/images/"+url.PathEscape(imageID)+"/json", nil, &image); e != nil {
		return "", "", e
	}
	version := image.Config.Labels["org.opencontainers.image.version"]
	if image.OS != "linux" || !supported(image.OS, image.Architecture) || !stable.MatchString(version) {
		return "", "", errors.New("update_unsupported")
	}
	return version, image.Architecture, nil
}
func (d *Docker) pull(ctx context.Context, tag string) error {
	req, e := http.NewRequestWithContext(ctx, "POST", d.Base+d.api+"/images/create?fromImage="+url.QueryEscape(d.Image)+"&tag="+url.QueryEscape(tag), nil)
	if e != nil {
		return e
	}
	res, e := d.Client.Do(req)
	if e != nil {
		return errors.New("update_docker_pull_failed")
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return errors.New("update_docker_pull_failed")
	}
	decoder := json.NewDecoder(io.LimitReader(res.Body, 16<<20))
	for {
		var line struct {
			Error string `json:"error"`
		}
		e = decoder.Decode(&line)
		if e == io.EOF {
			break
		}
		if e != nil || line.Error != "" {
			return errors.New("update_docker_pull_failed")
		}
	}
	var info struct {
		Config struct{ Labels map[string]string }
	}
	if e = d.request(ctx, "GET", "/images/"+url.PathEscape(d.Image+":"+tag)+"/json", nil, &info); e != nil {
		return e
	}
	if strings.TrimPrefix(info.Config.Labels["org.opencontainers.image.version"], "v") != strings.TrimPrefix(tag, "v") || info.Config.Labels["io.uptime-polaris.update-storage"] != Storage {
		return errors.New("update_image_invalid")
	}
	return nil
}
func networkEndpoint(endpoint map[string]any) map[string]any {
	out := map[string]any{}
	for _, key := range []string{"Aliases", "Links", "IPAMConfig", "DriverOpts", "GwPriority", "MacAddress"} {
		if value, ok := endpoint[key]; ok {
			out[key] = value
		}
	}
	return out
}
func (d *Docker) disconnect(ctx context.Context, info containerInfo) error {
	for network := range info.NetworkSettings.Networks {
		if network == "host" || network == "none" {
			continue
		}
		if e := d.request(ctx, "POST", "/networks/"+url.PathEscape(network)+"/disconnect", map[string]any{"Container": info.ID, "Force": true}, nil); e != nil {
			return e
		}
	}
	return nil
}
func (d *Docker) restore(ctx context.Context, j dockerJournal) error {
	if j.Replacement == "" {
		candidate, e := d.inspect(ctx, d.Container)
		if e == nil && candidate.ID != j.Old.ID {
			labels, _ := candidate.Config["Labels"].(map[string]any)
			if labels["io.uptime-polaris.update-backup"] != j.Backup {
				return errors.New("update_recovery_failed")
			}
			j.Replacement = candidate.ID
		} else if e != nil && !strings.HasSuffix(e.Error(), "_404") {
			return e
		}
	}
	if j.Replacement != "" {
		replacement, e := d.inspect(ctx, j.Replacement)
		if e == nil {
			if replacement.State.Running {
				if e = d.request(ctx, "POST", "/containers/"+j.Replacement+"/stop?t=20", nil, nil); e != nil {
					return e
				}
			}
			if e = d.request(ctx, "DELETE", "/containers/"+j.Replacement, nil, nil); e != nil {
				return e
			}
		} else if !strings.HasSuffix(e.Error(), "_404") {
			return e
		}
	}
	current, e := d.inspect(ctx, j.Old.ID)
	if e != nil {
		return e
	}
	if current.Name != j.Old.Name {
		if e = d.request(ctx, "POST", "/containers/"+j.Old.ID+"/rename?name="+url.QueryEscape(strings.TrimPrefix(j.Old.Name, "/")), nil, nil); e != nil {
			return e
		}
	}
	for name, endpoint := range j.Old.NetworkSettings.Networks {
		if name == "host" || name == "none" {
			continue
		}
		if _, present := current.NetworkSettings.Networks[name]; !present {
			if e = d.request(ctx, "POST", "/networks/"+url.PathEscape(name)+"/connect", map[string]any{"Container": j.Old.ID, "EndpointConfig": networkEndpoint(endpoint)}, nil); e != nil {
				return e
			}
		}
	}
	if e = d.request(ctx, "POST", "/containers/"+j.Old.ID+"/update", map[string]any{"RestartPolicy": j.Old.HostConfig["RestartPolicy"]}, nil); e != nil {
		return e
	}
	if !current.State.Running {
		if e = d.request(ctx, "POST", "/containers/"+j.Old.ID+"/start", nil, nil); e != nil {
			return e
		}
	}
	j.Pending = false
	return WriteJSON(filepath.Join(d.Dir, "docker.json"), j)
}
func (d *Docker) Recover(ctx context.Context) error {
	raw, e := os.ReadFile(filepath.Join(d.Dir, "docker.json"))
	if os.IsNotExist(e) {
		return nil
	}
	if e != nil {
		return e
	}
	var j dockerJournal
	if json.Unmarshal(raw, &j) != nil {
		return errors.New("update_state_invalid")
	}
	if !j.Pending {
		return nil
	}
	return d.restore(ctx, j)
}
func (d *Docker) Apply(ctx context.Context, release Release, phase func(string)) error {
	current, _, err := d.Current(ctx)
	if err != nil {
		return err
	}
	if !newer(release.Tag, current) {
		return errors.New("update_version_changed")
	}
	phase("downloading")
	if e := d.pull(ctx, release.Tag); e != nil {
		return e
	}
	old, e := d.inspect(ctx, d.Container)
	if e != nil {
		return e
	}
	if !old.State.Running {
		return errors.New("update_container_stopped")
	}
	if old.HostConfig["AutoRemove"] == true {
		return errors.New("update_manual_required")
	}
	if ports, ok := old.HostConfig["PortBindings"].(map[string]any); ok {
		for _, value := range ports {
			bindings, _ := value.([]any)
			for _, value := range bindings {
				binding, _ := value.(map[string]any)
				port, _ := binding["HostPort"].(string)
				if port == "" || port == "0" {
					return errors.New("update_manual_required")
				}
			}
		}
	}
	if old.HostConfig["PublishAllPorts"] == true {
		return errors.New("update_manual_required")
	}
	j := dockerJournal{Old: old, Backup: d.Container + "-backup-" + time.Now().UTC().Format("20060102T150405"), Pending: true}
	if e = WriteJSON(filepath.Join(d.Dir, "docker.json"), j); e != nil {
		return errors.New("update_storage_failed")
	}
	rollback := func() error {
		recoveryCtx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
		defer cancel()
		if err := d.restore(recoveryCtx, j); err != nil {
			slog.Error("container recovery failed", "error", err)
			return errors.New("update_recovery_failed")
		}
		current, _, e := d.Current(recoveryCtx)
		if e != nil || waitHealth(recoveryCtx, d.Health, current, 30*time.Second) != nil {
			slog.Error("restored container health check failed")
			return errors.New("update_recovery_failed")
		}
		return errors.New("update_rolled_back")
	}
	phase("restarting")
	if e = d.request(ctx, "POST", "/containers/"+old.ID+"/update", map[string]any{"RestartPolicy": map[string]any{"Name": "no"}}, nil); e != nil {
		return rollback()
	}
	if e = d.request(ctx, "POST", "/containers/"+old.ID+"/stop?t=20", nil, nil); e != nil {
		return rollback()
	}
	if e = d.disconnect(ctx, old); e != nil {
		return rollback()
	}
	if e = d.request(ctx, "POST", "/containers/"+old.ID+"/rename?name="+url.QueryEscape(j.Backup), nil, nil); e != nil {
		return rollback()
	}
	config := map[string]any{}
	for key, value := range old.Config {
		config[key] = value
	}
	config["Image"] = d.Image + ":" + release.Tag
	labels := map[string]any{}
	if existing, ok := config["Labels"].(map[string]any); ok {
		for key, value := range existing {
			labels[key] = value
		}
	}
	labels["io.uptime-polaris.update-backup"] = j.Backup
	labels["org.opencontainers.image.version"] = release.Tag
	config["Labels"] = labels
	host := map[string]any{}
	for key, value := range old.HostConfig {
		host[key] = value
	}
	if len(old.NetworkSettings.Ports) > 0 {
		bindings := map[string]any{}
		for port, value := range old.NetworkSettings.Ports {
			if value != nil {
				bindings[port] = value
			}
		}
		host["PortBindings"] = bindings
	}
	mounts, _ := host["Mounts"].([]any)
	binds, _ := host["Binds"].([]any)
	for _, mount := range old.Mounts {
		if mount.Type != "volume" {
			continue
		}
		present := false
		for _, value := range mounts {
			if v, ok := value.(map[string]any); ok && (v["Target"] == mount.Destination || v["Destination"] == mount.Destination) {
				present = true
			}
		}
		for _, value := range binds {
			if v, ok := value.(string); ok {
				parts := strings.Split(v, ":")
				if len(parts) > 1 && parts[1] == mount.Destination {
					present = true
				}
			}
		}
		if !present {
			mounts = append(mounts, map[string]any{"Type": "volume", "Source": mount.Name, "Target": mount.Destination, "ReadOnly": !mount.RW})
		}
	}
	host["Mounts"] = mounts
	config["HostConfig"] = host
	endpoints := map[string]any{}
	for name, endpoint := range old.NetworkSettings.Networks {
		if name == "host" || name == "none" {
			continue
		}
		endpoints[name] = networkEndpoint(endpoint)
	}
	config["NetworkingConfig"] = map[string]any{"EndpointsConfig": endpoints}
	var created struct {
		ID string `json:"Id"`
	}
	if e = d.request(ctx, "POST", "/containers/create?name="+url.QueryEscape(d.Container), config, &created); e != nil {
		return rollback()
	}
	j.Replacement = created.ID
	if e = WriteJSON(filepath.Join(d.Dir, "docker.json"), j); e != nil {
		return rollback()
	}
	if e = d.request(ctx, "POST", "/containers/"+created.ID+"/start", nil, nil); e != nil {
		return rollback()
	}
	phase("verifying")
	if e = waitHealth(ctx, d.Health, release.Tag, 60*time.Second); e != nil {
		return rollback()
	}
	j.Pending = false
	if e = WriteJSON(filepath.Join(d.Dir, "docker.json"), j); e != nil {
		return rollback()
	}
	return nil
}
