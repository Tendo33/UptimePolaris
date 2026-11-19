import schema from './subscription.schema.json';
import { parseSubscriptionPath } from './subscription-path';
import { SUBSCRIPTION_LIMITS, SubscriptionError, type SubscriptionDescriptor, type SubscriptionIssue } from './subscriptions';

type Schema = {
  $ref?: string; const?: unknown; enum?: unknown[]; type?: string | string[];
  anyOf?: Schema[]; required?: string[]; properties?: Record<string, Schema | undefined>;
  additionalProperties?: boolean | Schema; propertyNames?: Schema; items?: Schema;
  minLength?: number; maxLength?: number; pattern?: string; minimum?: number; maximum?: number;
  minItems?: number; maxItems?: number; uniqueItems?: boolean; minProperties?: number; maxProperties?: number;
};
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const encoder = new TextEncoder();

function validate(value: unknown, rule: Schema, path: string, issues: SubscriptionIssue[], depth = 0): void {
  const fail = () => { if (issues.length < 40) issues.push({ code: 'subscription_descriptor_invalid', path }); };
  if (depth > 32) return fail();
  if (rule.$ref) {
    const name = rule.$ref.replace('#/$defs/', '');
    return validate(value, (schema.$defs as Record<string, Schema>)[name], path, issues, depth + 1);
  }
  if (Object.hasOwn(rule, 'const') && value !== rule.const) return fail();
  if (rule.enum && !rule.enum.includes(value)) return fail();
  if (rule.anyOf && !rule.anyOf.some(candidate => { const errors: SubscriptionIssue[] = []; validate(value, candidate, path, errors, depth + 1); return !errors.length; })) return fail();
  const types = rule.type ? Array.isArray(rule.type) ? rule.type : [rule.type] : [];
  if (types.length && !types.some(type => type === 'null' ? value === null : type === 'array' ? Array.isArray(value) : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value) : type === 'integer' ? Number.isSafeInteger(value) : typeof value === type)) return fail();
  if (typeof value === 'string') {
    if (value.length < (rule.minLength ?? 0) || [...value].length > (rule.maxLength ?? Infinity) || rule.pattern && !new RegExp(rule.pattern).test(value)) fail();
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < (rule.minimum ?? -Infinity) || value > (rule.maximum ?? Infinity)) fail();
  } else if (Array.isArray(value)) {
    if (value.length < (rule.minItems ?? 0) || value.length > (rule.maxItems ?? Infinity) || rule.uniqueItems && new Set(value.map(item => JSON.stringify(item))).size !== value.length) fail();
    if (rule.items) value.forEach((item, index) => validate(item, rule.items!, `${path}/${index}`, issues, depth + 1));
  } else if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>, keys = Object.keys(object);
    if (keys.length < (rule.minProperties ?? 0) || keys.length > (rule.maxProperties ?? Infinity)) fail();
    for (const key of rule.required ?? []) if (!Object.hasOwn(object, key)) issues.push({ code: 'subscription_descriptor_invalid', path: `${path}/${key}` });
    for (const key of keys) {
      if (unsafeKeys.has(key)) { fail(); continue; }
      if (rule.propertyNames) validate(key, rule.propertyNames, `${path}/${key}`, issues, depth + 1);
      const child = rule.properties?.[key];
      if (child) validate(object[key], child, `${path}/${key}`, issues, depth + 1);
      else if (rule.additionalProperties === false) issues.push({ code: 'subscription_descriptor_invalid', path: `${path}/${key}` });
      else if (typeof rule.additionalProperties === 'object') validate(object[key], rule.additionalProperties, `${path}/${key}`, issues, depth + 1);
    }
  }
}

export function validateSubscriptionDescriptor(value: unknown): SubscriptionDescriptor {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { throw new SubscriptionError('subscription_descriptor_invalid'); }
  if (!encoded || encoder.encode(encoded).length > SUBSCRIPTION_LIMITS.descriptorBytes) throw new SubscriptionError('subscription_limit_exceeded', 413);
  if (value && typeof value === 'object' && 'schemaVersion' in value && value.schemaVersion !== 1) throw new SubscriptionError('subscription_schema_unsupported');
  const issues: SubscriptionIssue[] = [];
  validate(value, schema as Schema, '$', issues);
  if (issues.length) throw new SubscriptionError('subscription_descriptor_invalid', 400, issues.slice(0, 40));
  const descriptor = value as SubscriptionDescriptor;
  const invalid = (path: string) => issues.push({ code: 'subscription_descriptor_invalid', path });
  const paths = (object: unknown, path: string) => {
    if (!object || typeof object !== 'object') return;
    for (const [key, child] of Object.entries(object)) {
      if (typeof child === 'string' && child.startsWith('$')) {
        try { parseSubscriptionPath(child); } catch { invalid(`${path}/${key}`); }
      } else paths(child, `${path}/${key}`);
    }
  };
  paths(descriptor.items, '$/items'); paths(descriptor.observations, '$/observations'); paths(descriptor.metrics, '$/metrics');
  const sourcePage = descriptor.sourcePage;
  if (sourcePage) {
    if (descriptor.inputs[sourcePage.baseUrlInput]?.type !== 'url' || sourcePage.path.startsWith('//') || /[\\?#]/.test(sourcePage.path)) invalid('$/sourcePage');
    for (const match of sourcePage.path.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) if (!descriptor.inputs[match[1]] || descriptor.inputs[match[1]].type === 'secret') invalid('$/sourcePage/path');
  }
  for (const [id, input] of Object.entries(descriptor.inputs)) {
    if (input.type === 'secret' && input.default !== undefined || input.type === 'enum' && !input.options?.length) invalid(`$/inputs/${id}`);
    if (input.type === 'url' && input.default !== undefined) {
      try { const url = new URL(String(input.default)); if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) invalid(`$/inputs/${id}/default`); } catch { invalid(`$/inputs/${id}/default`); }
    }
  }
  for (const [id, request] of Object.entries(descriptor.requests)) {
    if (descriptor.inputs[request.baseUrlInput]?.type !== 'url' || request.path.startsWith('//') || request.path.includes('\\') || request.path.includes('#')) invalid(`$/requests/${id}`);
    if (request.method === 'GET' && request.body !== undefined) invalid(`$/requests/${id}/body`);
    for (const [name, content] of Object.entries(request.headers ?? {})) {
      if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) || /^(host|connection|content-length|cookie|set-cookie|transfer-encoding|proxy-authorization)$/i.test(name) || /[\r\n]/.test(content)) invalid(`$/requests/${id}/headers/${name}`);
      if (/authorization|api[-_]?key|token|secret/i.test(name) && ![...content.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].some(match => descriptor.inputs[match[1]]?.type === 'secret')) invalid(`$/requests/${id}/headers/${name}`);
    }
    for (const [name, content] of Object.entries(request.query ?? {})) if (/api[-_]?key|token|secret|password/i.test(name) && ![...content.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].some(match => descriptor.inputs[match[1]]?.type === 'secret')) invalid(`$/requests/${id}/query/${name}`);
    const checkBody = (value: unknown, path: string) => {
      if (!value || typeof value !== 'object') return;
      for (const [name, child] of Object.entries(value)) {
        if (/^(authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|token|client[-_]?secret|secret|password)$/i.test(name) && ![...JSON.stringify(child).matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)].some(match => descriptor.inputs[match[1]]?.type === 'secret')) invalid(`${path}/${name}`);
        checkBody(child, `${path}/${name}`);
      }
    };
    checkBody(request.body, `$/requests/${id}/body`);
    const templates = JSON.stringify({ path: request.path, query: request.query, headers: request.headers, body: request.body });
    for (const match of templates.matchAll(/\{([A-Za-z][A-Za-z0-9_]*)\}/g)) if (!descriptor.inputs[match[1]]) invalid(`$/requests/${id}`);
    if (request.pagination) {
      const page = request.pagination;
      if (page.type === 'cursor' && !page.nextPath || page.location === 'body' && (request.method !== 'POST' || !request.body || typeof request.body !== 'object' || Array.isArray(request.body))) invalid(`$/requests/${id}/pagination`);
      try { parseSubscriptionPath(page.itemsPath); if (page.nextPath) parseSubscriptionPath(page.nextPath); } catch { invalid(`$/requests/${id}/pagination`); }
    }
  }
  for (const [name, source] of Object.entries({ items: descriptor.items, observations: descriptor.observations, availability: descriptor.metrics?.availability })) {
    if (source && !descriptor.requests[source.request]) invalid(`$/${name}/request`);
  }
  const observation = descriptor.observations;
  if (observation.mode === 'heartbeat' && (!observation.observedAt || !observation.latestBy)) invalid('$/observations/observedAt');
  if (observation.latestBy && observation.latestBy !== observation.observedAt?.path) invalid('$/observations/latestBy');
  if (observation.lookupBy && observation.join || observation.request !== descriptor.items.request && !observation.lookupBy && !observation.join) invalid('$/observations');
  if (observation.observedAt?.format === 'yyyy-MM-dd HH:mm:ss[.SSS]' && observation.observedAt.timeZone !== 'UTC') invalid('$/observations/observedAt/timeZone');
  if (issues.length) throw new SubscriptionError('subscription_descriptor_invalid', 400, issues.slice(0, 40));
  return descriptor;
}

export function subscriptionParameters(descriptor: SubscriptionDescriptor, input: unknown): Record<string, string | number | boolean> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new SubscriptionError('subscription_parameters_invalid');
  const supplied = input as Record<string, unknown>, result: Record<string, string | number | boolean> = Object.create(null);
  const issues: SubscriptionIssue[] = [];
  for (const key of Object.keys(supplied)) if (!Object.hasOwn(descriptor.inputs, key)) issues.push({ code: 'subscription_parameter_unknown', path: key });
  for (const [key, spec] of Object.entries(descriptor.inputs)) {
    const value = supplied[key] ?? spec.default;
    const invalid = () => issues.push({ code: 'subscription_parameters_invalid', path: key });
    if (value === undefined || value === '') { if (spec.required) invalid(); continue; }
    if (spec.type === 'number') { if (typeof value !== 'number' || !Number.isFinite(value)) { invalid(); continue; } }
    else if (spec.type === 'boolean') { if (typeof value !== 'boolean') { invalid(); continue; } }
    else if (typeof value !== 'string' || value.length > 8192 || /[\u0000\r\n]/.test(value)) { invalid(); continue; }
    if (spec.type === 'enum' && !spec.options?.includes(String(value))) { invalid(); continue; }
    if (spec.type === 'url') {
      try { const url = new URL(String(value)); if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search) { invalid(); continue; } } catch { invalid(); continue; }
    }
    result[key] = value as string | number | boolean;
  }
  if (issues.length) throw new SubscriptionError('subscription_parameters_invalid', 400, issues);
  return result;
}
