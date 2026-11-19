import { subscriptionValue, parseSubscriptionPath } from './subscription-path';
import { SUBSCRIPTION_LIMITS, SubscriptionError, type JsonValue, type SubscriptionDescriptor, type SubscriptionRequest } from './subscriptions';
import { subscriptionParameters } from './subscription-validation';

export interface SubscriptionTransport {
  fetch(url: URL, init: RequestInit): Promise<Response>;
  validateUrl(url: URL): Promise<void>;
  reserve?(): void;
}
export interface SubscriptionResponseCache { value: unknown; etag: string | null; modified: string | null; fetchedAt: number }
export interface SubscriptionFetchResult {
  responses: Record<string, unknown>;
  cache: Record<string, SubscriptionResponseCache>;
  failures: { requestId: string; code: string; retryAfterSec?: number }[];
  requests: number;
}

export function publicSubscriptionUrl(input: string | URL): URL {
  let url: URL;
  try { url = new URL(input); } catch { throw new SubscriptionError('subscription_source_blocked'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.port && url.port !== '443') throw new SubscriptionError('subscription_source_blocked');
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!hostname.includes('.') || hostname.includes(':') || /^\d+(\.\d+){3}$/.test(hostname) || /(^|\.)(localhost|local|internal|home|arpa|invalid|test|example)$/.test(hostname)) throw new SubscriptionError('subscription_source_blocked');
  return url;
}

export function subscriptionFileUrl(input: string): string {
  const url = publicSubscriptionUrl(input);
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === 'github.com' && parts.length >= 5 && parts[2] === 'blob' && parts.at(-1)!.endsWith('.json')) return publicSubscriptionUrl(`https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/${parts.slice(3).join('/')}`).href;
  return url.href;
}

export async function readSubscriptionJson(response: Response, maxBytes: number): Promise<{ value: unknown; bytes: number }> {
  if (!response.body) throw new SubscriptionError('subscription_response_invalid', 502);
  const length = Number(response.headers.get('content-length'));
  if (length > maxBytes) { await response.body.cancel(); throw new SubscriptionError('subscription_limit_exceeded', 413); }
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let text = '', bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new SubscriptionError('subscription_limit_exceeded', 413);
      text += decoder.decode(next.value, { stream: true });
    }
    text += decoder.decode();
    return { value: JSON.parse(text), bytes };
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof SubscriptionError) throw error;
    throw new SubscriptionError('subscription_response_invalid', 502);
  } finally { reader.releaseLock(); }
}

function substitute(value: string, parameters: Record<string, string | number | boolean>, encode = false): string {
  return value.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (_, key: string) => {
    const replacement = parameters[key];
    if (replacement === undefined) throw new SubscriptionError('subscription_parameters_invalid');
    return encode ? encodeURIComponent(String(replacement)) : String(replacement);
  });
}

export function subscriptionOrigins(descriptor: SubscriptionDescriptor, supplied: Record<string, string | number | boolean>): string[] {
  const parameters = subscriptionParameters(descriptor, supplied);
  return [...new Set(Object.values(descriptor.requests).map(request => publicSubscriptionUrl(String(parameters[request.baseUrlInput]).replace(/\/$/, '') + substitute(request.path, parameters, true)).origin))].sort();
}

export function subscriptionSourcePage(descriptor: SubscriptionDescriptor, parameters: Record<string, string | number | boolean>): string | null {
  if (!descriptor.sourcePage) return null;
  const page = descriptor.sourcePage;
  return publicSubscriptionUrl(String(parameters[page.baseUrlInput] ?? descriptor.inputs[page.baseUrlInput]?.default).replace(/\/$/, '') + substitute(page.path, parameters, true)).href;
}

export function subscriptionCredentialBindings(descriptor: SubscriptionDescriptor, supplied: Record<string, string | number | boolean>): Record<string, string[]> {
  const parameters = subscriptionParameters(descriptor, supplied), bindings: Record<string, string[]> = {};
  for (const [name, input] of Object.entries(descriptor.inputs)) if (input.type === 'secret') {
    bindings[name] = [...new Set(Object.values(descriptor.requests).filter(request => JSON.stringify(request).includes(`{${name}}`)).map(request => publicSubscriptionUrl(String(parameters[request.baseUrlInput]).replace(/\/$/, '') + substitute(request.path, parameters, true)).origin))].sort();
  }
  return bindings;
}

function substituteBody(value: JsonValue, parameters: Record<string, string | number | boolean>): JsonValue {
  if (typeof value === 'string') {
    const match = /^\{([A-Za-z][A-Za-z0-9_]*)\}$/.exec(value);
    return match ? parameters[match[1]] ?? '' : substitute(value, parameters);
  }
  if (Array.isArray(value)) return value.map(item => substituteBody(item, parameters));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, substituteBody(item, parameters)]));
  return value;
}

function replaceArray(root: unknown, path: string, value: unknown[]): void {
  const parts = parseSubscriptionPath(path);
  if (!parts.length || parts.includes(null)) throw new SubscriptionError('subscription_pagination_invalid');
  let target = root as Record<string | number, unknown>;
  for (const key of parts.slice(0, -1)) {
    if (!target || typeof target !== 'object' || !Object.hasOwn(target, key!)) throw new SubscriptionError('subscription_pagination_invalid');
    target = target[key!] as typeof target;
  }
  target[parts.at(-1)!] = value;
}

export async function fetchSubscriptionResponses(
  descriptor: SubscriptionDescriptor,
  supplied: Record<string, string | number | boolean>,
  transport: SubscriptionTransport,
  now: number,
  previous: Record<string, SubscriptionResponseCache> = {},
  force = false,
): Promise<SubscriptionFetchResult> {
  const parameters = subscriptionParameters(descriptor, supplied);
  const result: SubscriptionFetchResult = { responses: Object.create(null), cache: { ...previous }, failures: [], requests: 0 };
  const deadline = Date.now() + SUBSCRIPTION_LIMITS.runTimeoutMs;
  let totalBytes = 0;
  async function request(url: URL, init: RequestInit, cached?: SubscriptionResponseCache): Promise<SubscriptionResponseCache> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.max(1, Math.min(SUBSCRIPTION_LIMITS.timeoutMs, deadline - Date.now())));
    try {
      for (let redirects = 0; ; redirects++) {
        if (Date.now() >= deadline) throw new SubscriptionError('subscription_budget_deferred', 503);
        if (result.requests >= SUBSCRIPTION_LIMITS.fetches) throw new SubscriptionError('subscription_limit_exceeded', 413);
        await transport.validateUrl(url);
        if (Date.now() >= deadline) throw new SubscriptionError('subscription_budget_deferred', 503);
        transport.reserve?.(); result.requests++;
        const response = await transport.fetch(url, { ...init, redirect: 'manual', signal: controller.signal });
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          await response.body?.cancel();
          const location = response.headers.get('location');
          if (!location || redirects >= SUBSCRIPTION_LIMITS.redirects) throw new SubscriptionError('subscription_redirect_invalid', 502);
          const next = publicSubscriptionUrl(new URL(location, url));
          if (next.origin !== url.origin && init.body !== undefined) throw new SubscriptionError('subscription_redirect_invalid', 502);
          if (next.origin !== url.origin) init = { ...init, headers: { accept: 'application/json' } };
          if (response.status === 303 || [301, 302].includes(response.status) && init.method === 'POST') init = { ...init, method: 'GET', body: undefined };
          url = next; continue;
        }
        if (response.status === 304 && cached) { await response.body?.cancel(); return { ...cached, fetchedAt: now }; }
        if (!response.ok) {
          await response.body?.cancel();
          const error = new SubscriptionError(response.status === 429 ? 'subscription_rate_limited' : [401, 403].includes(response.status) ? 'subscription_authentication_failed' : 'subscription_fetch_failed', 502);
          const retry = response.headers.get('retry-after');
          if (retry && [429, 503].includes(response.status)) {
            const delay = /^\d+$/.test(retry) ? Number(retry) : (Date.parse(retry) / 1000 - now);
            if (Number.isFinite(delay) && delay > 0) error.retryAfterSec = Math.min(86400, Math.ceil(delay));
          }
          throw error;
        }
        const parsed = await readSubscriptionJson(response, Math.min(SUBSCRIPTION_LIMITS.responseBytes, SUBSCRIPTION_LIMITS.runBytes - totalBytes));
        totalBytes += parsed.bytes;
        return { value: parsed.value, etag: response.headers.get('etag'), modified: response.headers.get('last-modified'), fetchedAt: now };
      }
    } finally { clearTimeout(timeout); }
  }
  for (const [id, spec] of Object.entries(descriptor.requests)) {
    const cached = previous[id];
    if (!force && cached && now < cached.fetchedAt + spec.intervalSec) { result.responses[id] = cached.value; continue; }
    try {
      const base = publicSubscriptionUrl(String(parameters[spec.baseUrlInput]));
      const url = publicSubscriptionUrl(`${base.href.replace(/\/$/, '')}${substitute(spec.path, parameters, true)}`);
      const headers: Record<string, string> = { accept: 'application/json' };
      for (const [key, value] of Object.entries(spec.headers ?? {})) headers[key] = substitute(value, parameters);
      for (const [key, value] of Object.entries(spec.query ?? {})) url.searchParams.set(key, substitute(value, parameters));
      if (spec.method === 'POST') headers['content-type'] = 'application/json';
      if (cached && !spec.pagination) {
        if (cached.etag) headers['if-none-match'] = cached.etag;
        if (cached.modified) headers['if-modified-since'] = cached.modified;
      }
      const body = spec.body === undefined ? undefined : substituteBody(spec.body, parameters);
      const pagination = spec.pagination;
      let cursor: string | number | undefined = pagination?.start ?? (pagination?.type === 'cursor' ? undefined : 1);
      let combined: SubscriptionResponseCache | undefined;
      const combinedItems: unknown[] = [], cursors = new Set<string>();
      for (let page = 0; page < (pagination?.maxPages ?? 1); page++) {
        const pageUrl = new URL(url), pageBody = structuredClone(body);
        if (pagination && cursor !== undefined) {
          if (pagination.location === 'query') pageUrl.searchParams.set(pagination.parameter, String(cursor));
          else (pageBody as Record<string, JsonValue>)[pagination.parameter] = cursor;
        }
        const response = await request(pageUrl, { method: spec.method, headers, body: pageBody === undefined ? undefined : JSON.stringify(pageBody) }, pagination ? undefined : cached);
        combined ??= response;
        if (!pagination) break;
        const items = subscriptionValue(response.value, pagination.itemsPath);
        if (!Array.isArray(items)) throw new SubscriptionError('subscription_pagination_invalid', 502);
        combinedItems.push(...items);
        if (combinedItems.length > SUBSCRIPTION_LIMITS.items) throw new SubscriptionError('subscription_limit_exceeded', 413);
        const next = pagination.nextPath ? subscriptionValue(response.value, pagination.nextPath) : null;
        const done = pagination.type === 'cursor' ? next === null || next === undefined || next === '' : items.length === 0 || pagination.nextPath !== undefined && !next;
        if (done) break;
        if (page + 1 === pagination.maxPages) throw new SubscriptionError('subscription_pagination_incomplete', 502);
        cursor = pagination.type === 'page' ? Number(cursor) + 1 : typeof next === 'string' || typeof next === 'number' ? next : '';
        if (cursor === '' || String(cursor).length > 2048 || cursors.has(String(cursor))) throw new SubscriptionError('subscription_pagination_invalid', 502);
        cursors.add(String(cursor));
      }
      if (!combined) throw new SubscriptionError('subscription_fetch_failed', 502);
      if (pagination) replaceArray(combined.value, pagination.itemsPath, combinedItems);
      result.responses[id] = combined.value; result.cache[id] = combined;
    } catch (error) {
      if (error instanceof SubscriptionError && error.code === 'subscription_budget_deferred') throw error;
      result.failures.push({ requestId: id, code: error instanceof SubscriptionError ? error.code : 'subscription_fetch_failed', ...(error instanceof SubscriptionError && error.retryAfterSec ? { retryAfterSec: error.retryAfterSec } : {}) });
    }
  }
  return result;
}
