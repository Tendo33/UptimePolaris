package polaris

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

//go:embed subscription.schema.json
var subscriptionSchemaJSON []byte

//go:embed subscription-templates.json
var subscriptionTemplatesJSON []byte

//go:embed subscription-limits.json
var subscriptionLimitsJSON []byte

func subscriptionCapabilities() Object {
	var limits Object
	if err := json.Unmarshal(subscriptionLimitsJSON, &limits); err != nil {
		panic(err)
	}
	capabilities := object(object(object(subscriptionSchema["properties"])["capabilities"])["items"])["enum"]
	return Object{"supported": true, "schemaVersion": 1, "minimumIntervalSec": limits["minimumIntervalSec"], "limits": limits, "capabilities": capabilities}
}

var subscriptionSchema = func() Object {
	var value Object
	if err := json.Unmarshal(subscriptionSchemaJSON, &value); err != nil {
		panic(err)
	}
	return value
}()
var subscriptionTemplates = func() []Object {
	var value []Object
	if err := json.Unmarshal(subscriptionTemplatesJSON, &value); err != nil {
		panic(err)
	}
	return value
}()
var subscriptionPathToken = regexp.MustCompile(`^(?:\.([A-Za-z_][A-Za-z0-9_-]*)|\[(\*|0|[1-9][0-9]*|"(?:[^"\\]|\\.)*"|'[^']*')\])`)
var subscriptionInputToken = regexp.MustCompile(`\{([A-Za-z][A-Za-z0-9_]*)\}`)

func subscriptionError(code string) error { return failure("subscription_"+code, 400) }
func subObject(value any) Object          { return object(value) }
func subKeys(value Object) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}
func subUnsafe(key string) bool {
	return key == "__proto__" || key == "constructor" || key == "prototype"
}

func validateSubSchema(value any, rule Object, depth int) bool {
	if depth > 32 {
		return false
	}
	if ref := str(rule, "$ref"); ref != "" {
		return validateSubSchema(value, object(object(subscriptionSchema["$defs"])[strings.TrimPrefix(ref, "#/$defs/")]), depth+1)
	}
	if expected, present := rule["const"]; present && !reflect.DeepEqual(expected, value) {
		return false
	}
	if choices, present := rule["enum"]; present {
		valid := false
		for _, choice := range array(choices) {
			if reflect.DeepEqual(choice, value) {
				valid = true
			}
		}
		if !valid {
			return false
		}
	}
	if choices, present := rule["anyOf"]; present {
		valid := false
		for _, choice := range array(choices) {
			if validateSubSchema(value, object(choice), depth+1) {
				valid = true
				break
			}
		}
		if !valid {
			return false
		}
	}
	types := stringsOf(rule["type"])
	if kind, ok := rule["type"].(string); ok {
		types = []string{kind}
	}
	if len(types) > 0 {
		valid := false
		for _, kind := range types {
			switch kind {
			case "null":
				valid = valid || value == nil
			case "object":
				_, ok := value.(map[string]any)
				_, named := value.(Object)
				valid = valid || ok || named
			case "array":
				_, ok := value.([]any)
				valid = valid || ok
			case "string":
				_, ok := value.(string)
				valid = valid || ok
			case "boolean":
				_, ok := value.(bool)
				valid = valid || ok
			case "number", "integer":
				n, ok := value.(float64)
				valid = valid || ok && !math.IsNaN(n) && !math.IsInf(n, 0) && (kind != "integer" || math.Trunc(n) == n)
			}
		}
		if !valid {
			return false
		}
	}
	within := func(length int, minKey, maxKey string) bool {
		if lower, ok := rule[minKey]; ok && float64(length) < number(lower) {
			return false
		}
		if upper, ok := rule[maxKey]; ok && float64(length) > number(upper) {
			return false
		}
		return true
	}
	switch typed := value.(type) {
	case string:
		if !within(len([]rune(typed)), "minLength", "maxLength") {
			return false
		}
		if pattern := str(rule, "pattern"); pattern != "" {
			ok, err := regexp.MatchString(pattern, typed)
			if err != nil || !ok {
				return false
			}
		}
	case float64:
		if lower, ok := rule["minimum"]; ok && typed < number(lower) {
			return false
		}
		if upper, ok := rule["maximum"]; ok && typed > number(upper) {
			return false
		}
	case []any:
		if !within(len(typed), "minItems", "maxItems") {
			return false
		}
		seen := map[string]bool{}
		for _, item := range typed {
			key := encode(item)
			if boolean(rule["uniqueItems"]) && seen[key] {
				return false
			}
			seen[key] = true
			if child := object(rule["items"]); child != nil && !validateSubSchema(item, child, depth+1) {
				return false
			}
		}
	case map[string]any:
		return validateSubObject(Object(typed), rule, depth, within)
	case Object:
		return validateSubObject(typed, rule, depth, within)
	}
	return true
}

func validateSubObject(value, rule Object, depth int, within func(int, string, string) bool) bool {
	if !within(len(value), "minProperties", "maxProperties") {
		return false
	}
	for _, key := range stringsOf(rule["required"]) {
		if _, ok := value[key]; !ok {
			return false
		}
	}
	properties := object(rule["properties"])
	for key, child := range value {
		if subUnsafe(key) {
			return false
		}
		if names := object(rule["propertyNames"]); names != nil && !validateSubSchema(key, names, depth+1) {
			return false
		}
		if childRule := object(properties[key]); childRule != nil {
			if !validateSubSchema(child, childRule, depth+1) {
				return false
			}
		} else if rule["additionalProperties"] == false {
			return false
		} else if extra := object(rule["additionalProperties"]); extra != nil && !validateSubSchema(child, extra, depth+1) {
			return false
		}
	}
	return true
}

type subPathPart struct {
	key      string
	index    int
	array    bool
	wildcard bool
}
type subMatch struct {
	value  any
	parent any
	root   any
}

func subPathParts(path string) ([]subPathPart, error) {
	if len(path) == 0 || len(path) > 512 || path[0] != '$' {
		return nil, subscriptionError("path_invalid")
	}
	parts := []subPathPart{}
	for offset := 1; offset < len(path); {
		match := subscriptionPathToken.FindStringSubmatch(path[offset:])
		if match == nil {
			return nil, subscriptionError("path_invalid")
		}
		part := subPathPart{key: match[1]}
		raw := match[2]
		if raw == "*" {
			part.wildcard = true
		} else if strings.HasPrefix(raw, "\"") {
			if json.Unmarshal([]byte(raw), &part.key) != nil {
				return nil, subscriptionError("path_invalid")
			}
		} else if strings.HasPrefix(raw, "'") {
			part.key = raw[1 : len(raw)-1]
		} else if raw != "" {
			index, err := strconv.Atoi(raw)
			if err != nil {
				return nil, subscriptionError("path_invalid")
			}
			part.index, part.array = index, true
		}
		if subUnsafe(part.key) {
			return nil, subscriptionError("path_invalid")
		}
		parts = append(parts, part)
		if len(parts) > 24 {
			return nil, subscriptionError("path_invalid")
		}
		offset += len(match[0])
	}
	return parts, nil
}

func subPath(root any, path string, strict bool) ([]subMatch, error) {
	parts, err := subPathParts(path)
	if err != nil {
		return nil, err
	}
	matches := []subMatch{{root, nil, root}}
	for _, part := range parts {
		next := []subMatch{}
		for _, match := range matches {
			if part.wildcard {
				values, ok := match.value.([]any)
				if !ok {
					if strict {
						return nil, subscriptionError("catalog_invalid")
					}
					continue
				}
				for _, value := range values {
					next = append(next, subMatch{value, match.parent, root})
				}
			} else if part.array {
				values, ok := match.value.([]any)
				if !ok || part.index >= len(values) {
					if strict {
						return nil, subscriptionError("catalog_invalid")
					}
					continue
				}
				next = append(next, subMatch{values[part.index], values, root})
			} else if value, ok := object(match.value)[part.key]; ok {
				next = append(next, subMatch{value, match.value, root})
			} else if strict {
				return nil, subscriptionError("catalog_invalid")
			}
			if len(next) > 10000 {
				return nil, subscriptionError("limit_exceeded")
			}
		}
		matches = next
	}
	return matches, nil
}

func subValue(root any, path string) any {
	matches, err := subPath(root, path, false)
	if err != nil || len(matches) != 1 {
		return nil
	}
	return matches[0].value
}
func subField(selector any, match subMatch) any {
	if path, ok := selector.(string); ok {
		return subValue(match.value, path)
	}
	field := object(selector)
	if field == nil {
		return nil
	}
	value, constant := field["constant"]
	if !constant {
		from := match.value
		if field["from"] == "parent" {
			from = match.parent
		} else if field["from"] == "root" {
			from = match.root
		}
		value = subValue(from, str(field, "path"))
	}
	if value == nil {
		value = field["default"]
	}
	if value == nil {
		return nil
	}
	if boolean(field["number"]) || field["scale"] != nil {
		parsed, err := strconv.ParseFloat(fmt.Sprint(value), 64)
		if err != nil || math.IsNaN(parsed) || math.IsInf(parsed, 0) {
			return nil
		}
		scale := 1.0
		if field["scale"] != nil {
			scale = number(field["scale"])
		}
		value = parsed * scale
	}
	if field["prefix"] != nil || field["suffix"] != nil {
		return str(field, "prefix") + fmt.Sprint(value) + str(field, "suffix")
	}
	return value
}

func subFilter(value any, filter Object) bool {
	if filter == nil {
		return true
	}
	if filter["op"] == "and" {
		for _, child := range array(filter["conditions"]) {
			if !subFilter(value, object(child)) {
				return false
			}
		}
		return true
	}
	actual := subValue(value, str(filter, "path"))
	if filter["op"] == "exists" {
		return actual != nil
	}
	if filter["op"] == "eq" {
		return reflect.DeepEqual(actual, filter["value"])
	}
	for _, expected := range array(filter["values"]) {
		if reflect.DeepEqual(actual, expected) {
			return true
		}
	}
	return false
}

func validateSubscriptionDescriptor(value Object) error {
	if len(encode(value)) > 262144 {
		return subscriptionError("limit_exceeded")
	}
	if integer(value, "schemaVersion") != 1 {
		return subscriptionError("schema_unsupported")
	}
	if !validateSubSchema(value, subscriptionSchema, 0) {
		return subscriptionError("descriptor_invalid")
	}
	inputs, requests := object(value["inputs"]), object(value["requests"])
	if page := object(value["sourcePage"]); page != nil {
		path := str(page, "path")
		if object(inputs[str(page, "baseUrlInput")])["type"] != "url" || strings.HasPrefix(path, "//") || strings.ContainsAny(path, "\\?#") {
			return subscriptionError("descriptor_invalid")
		}
		for _, match := range subscriptionInputToken.FindAllStringSubmatch(path, -1) {
			input := object(inputs[match[1]])
			if input == nil || input["type"] == "secret" {
				return subscriptionError("descriptor_invalid")
			}
		}
	}
	for _, raw := range inputs {
		input := object(raw)
		if input["type"] == "secret" && input["default"] != nil || input["type"] == "enum" && len(array(input["options"])) == 0 {
			return subscriptionError("descriptor_invalid")
		}
		if input["type"] == "url" && input["default"] != nil {
			address, err := url.Parse(fmt.Sprint(input["default"]))
			if err != nil || address.Scheme != "https" || address.Hostname() == "" || address.User != nil || address.RawQuery != "" || address.Fragment != "" {
				return subscriptionError("descriptor_invalid")
			}
		}
	}
	for _, raw := range requests {
		request := object(raw)
		if object(inputs[str(request, "baseUrlInput")])["type"] != "url" || strings.HasPrefix(str(request, "path"), "//") || strings.ContainsAny(str(request, "path"), "\\#") || request["method"] == "GET" && request["body"] != nil {
			return subscriptionError("descriptor_invalid")
		}
		for _, match := range subscriptionInputToken.FindAllStringSubmatch(encode(request), -1) {
			if inputs[match[1]] == nil {
				return subscriptionError("descriptor_invalid")
			}
		}
		for name, raw := range object(request["headers"]) {
			if !regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]+$").MatchString(name) || strings.ContainsAny(fmt.Sprint(raw), "\r\n") || contains([]string{"host", "connection", "content-length", "cookie", "set-cookie", "transfer-encoding", "proxy-authorization"}, strings.ToLower(name)) {
				return subscriptionError("descriptor_invalid")
			}
			if !validSubscriptionCredentialField(name, fmt.Sprint(raw), inputs, true) {
				return subscriptionError("descriptor_invalid")
			}
		}
		for name, raw := range object(request["query"]) {
			if !validSubscriptionCredentialField(name, fmt.Sprint(raw), inputs, false) {
				return subscriptionError("descriptor_invalid")
			}
		}
		var checkBody func(any) bool
		checkBody = func(value any) bool {
			for name, child := range object(value) {
				sensitive := regexp.MustCompile(`(?i)^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|client[-_]?secret|secret|password)$`).MatchString(name)
				if sensitive && (!validSubscriptionCredentialField(name, encode(child), inputs, false) || !validSubscriptionCredentialField(name, encode(child), inputs, true)) || !checkBody(child) {
					return false
				}
			}
			for _, child := range array(value) {
				if !checkBody(child) {
					return false
				}
			}
			return true
		}
		if !checkBody(request["body"]) {
			return subscriptionError("descriptor_invalid")
		}
		pagination := object(request["pagination"])
		if pagination != nil && (pagination["type"] == "cursor" && pagination["nextPath"] == nil || pagination["location"] == "body" && (request["method"] != "POST" || object(request["body"]) == nil)) {
			return subscriptionError("descriptor_invalid")
		}
		if pagination != nil {
			for _, key := range []string{"itemsPath", "nextPath"} {
				if pagination[key] != nil {
					if _, err := subPathParts(str(pagination, key)); err != nil {
						return err
					}
				}
			}
		}
	}
	items, observations := object(value["items"]), object(value["observations"])
	if requests[str(items, "request")] == nil || requests[str(observations, "request")] == nil {
		return subscriptionError("descriptor_invalid")
	}
	availability := object(object(value["metrics"])["availability"])
	if availability != nil && requests[str(availability, "request")] == nil {
		return subscriptionError("descriptor_invalid")
	}
	observedAt := object(observations["observedAt"])
	if observedAt["format"] == "yyyy-MM-dd HH:mm:ss[.SSS]" && observedAt["timeZone"] != "UTC" {
		return subscriptionError("descriptor_invalid")
	}
	if observations["mode"] == "heartbeat" && (observations["observedAt"] == nil || observations["latestBy"] == nil) {
		return subscriptionError("descriptor_invalid")
	}
	if observations["latestBy"] != nil && observations["latestBy"] != object(observations["observedAt"])["path"] {
		return subscriptionError("descriptor_invalid")
	}
	if observations["lookupBy"] != nil && observations["join"] != nil || observations["request"] != items["request"] && observations["lookupBy"] == nil && observations["join"] == nil {
		return subscriptionError("descriptor_invalid")
	}
	var checkPaths func(any) error
	checkPaths = func(value any) error {
		for _, child := range array(value) {
			if err := checkPaths(child); err != nil {
				return err
			}
		}
		for _, child := range object(value) {
			if path, ok := child.(string); ok && strings.HasPrefix(path, "$") {
				if _, err := subPathParts(path); err != nil {
					return err
				}
			} else if err := checkPaths(child); err != nil {
				return err
			}
		}
		return nil
	}
	if err := checkPaths(items); err != nil {
		return err
	}
	if err := checkPaths(observations); err != nil {
		return err
	}
	if err := checkPaths(value["metrics"]); err != nil {
		return err
	}
	return nil
}

func validSubscriptionCredentialField(name, value string, inputs Object, header bool) bool {
	name = strings.ToLower(strings.NewReplacer("-", "", "_", "").Replace(name))
	sensitive := strings.Contains(name, "apikey") || strings.Contains(name, "token") || strings.Contains(name, "secret") || !header && strings.Contains(name, "password") || header && strings.Contains(name, "authorization")
	if !sensitive {
		return true
	}
	for _, match := range subscriptionInputToken.FindAllStringSubmatch(value, -1) {
		if object(inputs[match[1]])["type"] == "secret" {
			return true
		}
	}
	return false
}

func subTime(value any, spec Object, now int64) any {
	if value == nil {
		return nil
	}
	var seconds float64
	switch str(spec, "format") {
	case "unix-seconds", "unix-milliseconds":
		n, err := strconv.ParseFloat(fmt.Sprint(value), 64)
		if err != nil {
			return nil
		}
		seconds = n
		if spec["format"] == "unix-milliseconds" {
			seconds /= 1000
		}
	case "yyyy-MM-dd HH:mm:ss[.SSS]":
		if spec["timeZone"] != "UTC" {
			return nil
		}
		parsed, err := time.Parse("2006-01-02 15:04:05.999999999", fmt.Sprint(value))
		if err != nil {
			return nil
		}
		seconds = float64(parsed.UnixMilli()) / 1000
	default:
		parsed, err := time.Parse(time.RFC3339Nano, fmt.Sprint(value))
		if err != nil {
			return nil
		}
		seconds = float64(parsed.UnixMilli()) / 1000
	}
	if seconds < 0 || seconds > float64(now+300) || math.IsNaN(seconds) || math.IsInf(seconds, 0) {
		return nil
	}
	return seconds
}
