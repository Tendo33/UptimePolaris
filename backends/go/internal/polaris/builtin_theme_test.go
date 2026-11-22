package polaris

import (
	"context"
	"io"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func builtinThemeFixture(t *testing.T) Object {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "test", "themes", "fixtures", "builtin-theme.json"))
	if err != nil {
		t.Fatal(err)
	}
	fixture, err := decodeObject(string(raw))
	if err != nil {
		t.Fatal(err)
	}
	return fixture
}

func TestBuiltinThemeContract(t *testing.T) {
	fixture := builtinThemeFixture(t)
	for _, kind := range []string{"monitor", "agent"} {
		defaults := Object{}
		for _, option := range builtinThemeOptions(kind) {
			key := str(option, "key")
			if str(option, "label") != key {
				t.Fatal("label must be a translation key", option)
			}
			defaults[key] = option["default"]
		}
		if encode(defaults) != encode(object(fixture["defaults"])[kind]) {
			t.Fatal(kind, defaults)
		}
		configured := object(object(fixture["configured"])[kind])
		view := resolveBuiltinPageView(kind, Object{"theme": nil, "themeOptions": configured})
		for key, want := range configured {
			if encode(view[key]) != encode(want) {
				t.Fatalf("%s.%s: got %v, want %v", kind, key, view[key], want)
			}
		}
	}
	for _, raw := range array(fixture["cases"]) {
		item := object(raw)
		t.Run(str(item, "name"), func(t *testing.T) {
			kind, want := str(item, "kind"), boolean(item["valid"])
			if got := validateBuiltinThemeOptions(kind, object(item["values"])); got != want {
				t.Fatalf("validator: got %v, want %v", got, want)
			}
			config := defaultPresentation()
			object(object(config["pages"])[kind])["themeOptions"] = item["values"]
			if got := validatePresentation(config); got != want {
				t.Fatalf("presentation: got %v, want %v", got, want)
			}
		})
	}
	for key, limit := range map[string]int{"headCode": 16 << 10, "contentHtml": 32 << 10} {
		config := defaultPresentation()
		page := object(object(config["pages"])["monitor"])
		page[key] = strings.Repeat("界", limit/3) + strings.Repeat("x", limit%3)
		if !validatePresentation(config) {
			t.Fatal(key, "exact UTF-8 limit rejected")
		}
		page[key] = str(page, key) + "x"
		if validatePresentation(config) {
			t.Fatal(key, "UTF-8 overflow accepted")
		}
	}
	view := resolveBuiltinPageView("agent", Object{"theme": nil, "themeOptions": Object{"showCountry": true}, "showCountry": false})
	if boolean(view["showCountry"]) {
		t.Fatal("options override privacy gate")
	}
	view = resolveBuiltinPageView("monitor", Object{"theme": Object{"short": "x", "version": "1", "theme": "x"}, "themeOptions": Object{"radius": 99}})
	if integer(view, "radius") != 12 {
		t.Fatal("installed options override builtin view")
	}
}

func TestBuiltinThemePublicConfig(t *testing.T) {
	s := newTestServer(t)
	fixture := builtinThemeFixture(t)
	_, state := s.request(t, "GET", "/api/admin/presentation", nil, true)
	config := object(state["config"])
	save := func() {
		t.Helper()
		code, result := s.request(t, "PUT", "/api/admin/presentation", Object{"config": config, "revision": state["revision"]}, true)
		expectStatus(t, code, 200, result)
		state, config = result, object(result["config"])
	}
	public := func(kind string) Object {
		t.Helper()
		code, result := s.request(t, "GET", "/api/public/config?preview="+kind, nil, true)
		expectStatus(t, code, 200, result)
		return result
	}
	checkOptions := func(kind string, result, values Object) {
		t.Helper()
		view := object(result["presentation"])
		for key, want := range values {
			if encode(view[key]) != encode(want) {
				t.Fatalf("%s.%s: got %v, want %v", kind, key, view[key], want)
			}
		}
	}
	baseline := public("monitor")
	for _, kind := range []string{"monitor", "agent"} {
		result := public(kind)
		checkOptions(kind, result, object(object(fixture["defaults"])[kind]))
		if result["theme_head_code"] != "" || result["theme_content_html"] != "" {
			t.Fatal("empty builtin injection", result)
		}
		page := object(object(config["pages"])[kind])
		page["themeOptions"] = object(fixture["configured"])[kind]
		page["headCode"] = `<style data-page="` + kind + `">body{opacity:1}</style>`
		page["contentHtml"] = "<p>" + kind + " content</p>"
	}
	config["agentEnabled"] = true
	config["domains"] = []any{Object{"hostname": "monitor.example", "page": "monitor"}, Object{"hostname": "agent.example", "page": "agent"}}
	save()
	for _, kind := range []string{"monitor", "agent"} {
		result, page := public(kind), object(object(config["pages"])[kind])
		checkOptions(kind, result, object(page["themeOptions"]))
		if result["theme"] != nil || result["theme_settings"] != nil || result["theme_head_code"] != page["headCode"] || result["theme_content_html"] != page["contentHtml"] {
			t.Fatal("builtin customization missing", result)
		}
		if encode(result["siteMeta"]) != encode(baseline["siteMeta"]) {
			t.Fatal("site metadata changed", result["siteMeta"])
		}
	}
	for _, patch := range []Object{{"themeOptions": Object{"radius": 1.5}}, {"themeOptions": Object{"title": "forbidden"}}, {"headCode": strings.Repeat("界", 5462)}} {
		bad := clone(config)
		for key, value := range patch {
			object(object(bad["pages"])["monitor"])[key] = value
		}
		code, result := s.request(t, "PUT", "/api/admin/presentation", Object{"config": bad, "revision": state["revision"]}, true)
		expectStatus(t, code, 400, result)
		if str(result, "error") != "invalid_presentation" {
			t.Fatal(result)
		}
	}
	code, result := s.request(t, "GET", "/api/public/config", nil, false)
	expectStatus(t, code, 200, result)
	monitorPage := object(object(config["pages"])["monitor"])
	if !boolean(object(result["presentation"])["configured"]) || object(result["presentation"])["kind"] != "monitor" || result["theme_head_code"] != monitorPage["headCode"] || result["theme_content_html"] != monitorPage["contentHtml"] {
		t.Fatal("default monitor page missing", result)
	}
	code, machine := s.request(t, "POST", "/api/admin/agents", Object{"name": "country fixture"}, true)
	expectStatus(t, code, 201, machine)
	code, result = s.request(t, "POST", "/api/admin/agents/visibility", Object{"ids": []string{str(machine, "id")}, "is_public": true}, true)
	expectStatus(t, code, 200, result)
	if err := s.app.store.put(context.Background(), "machine", str(machine, "id"), Object{"region": "private city, US"}); err != nil {
		t.Fatal(err)
	}
	country := func() Object {
		t.Helper()
		code, result := s.request(t, "GET", "/api/public/servers?preview=agent", nil, true)
		expectStatus(t, code, 200, result)
		rows := array(result["servers"])
		if len(rows) != 1 {
			t.Fatal(result)
		}
		return object(rows[0])
	}
	if _, exists := country()["region"]; exists {
		t.Fatal("country visible while disabled")
	}
	object(object(object(config["pages"])["agent"])["themeOptions"])["showCountry"] = true
	save()
	if str(country(), "region") != "US" {
		t.Fatal("country must be a two-letter code")
	}

	code, installed := s.upload(t, packageZip(t, themeManifest(), nil))
	expectStatus(t, code, 200, installed)
	monitor := func() Object { return object(object(config["pages"])["monitor"]) }
	monitor()["theme"] = Object{"short": "fixture", "version": installed["versionKey"], "theme": "status"}
	monitor()["themeOptions"] = Object{"accent": "#123456"}
	save()
	if monitor()["headCode"] != nil || monitor()["contentHtml"] != nil {
		t.Fatal("theme switch retained injection")
	}
	head := "<script>window.installed=true</script>"
	monitor()["headCode"], monitor()["contentHtml"] = head, "<p>Installed content</p>"
	save()
	result = public("monitor")
	if result["theme_head_code"] != nil || result["theme_content_html"] != monitor()["contentHtml"] || str(object(result["theme_settings"]), "accent") != "#123456" {
		t.Fatal("installed customization changed", result)
	}
	host, _ := url.Parse(s.server.URL)
	config["domains"] = []any{Object{"hostname": host.Hostname(), "page": "monitor"}}
	save()
	response, err := s.client.Get(s.server.URL + "/")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(response.Body)
	response.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	if response.StatusCode != 200 || strings.Count(string(raw), head) != 1 {
		t.Fatal("installed server HTML must inject head once", string(raw))
	}
	monitor()["theme"] = nil
	save()
	if len(object(monitor()["themeOptions"])) != 0 || monitor()["headCode"] != nil || monitor()["contentHtml"] != nil {
		t.Fatal("restore builtin did not clear options and injection", monitor())
	}
	result = public("monitor")
	checkOptions("monitor", result, object(object(fixture["defaults"])["monitor"]))
	if result["theme_settings"] != nil || result["theme_head_code"] != "" || result["theme_content_html"] != "" {
		t.Fatal("restored builtin injection", result)
	}
}
