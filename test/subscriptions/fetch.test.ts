import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchSubscriptionResponses, publicSubscriptionUrl, readSubscriptionJson, type SubscriptionTransport } from '../../shared/subscription-fetch';
import { JSON_SUBSCRIPTION, KUMA_SUBSCRIPTION } from '../../shared/subscription-templates';
import { SubscriptionError } from '../../shared/subscriptions';

const now = 1795132800;
const parameters = { baseUrl: 'https://status.service.net', slug: 'main/a' };

test('catalog and heartbeat requests respect their own cache periods', async () => {
  const urls: string[] = [];
  const transport: SubscriptionTransport = { validateUrl: async () => {}, fetch: async url => { urls.push(url.href); return Response.json({ items: [] }); } };
  const first = await fetchSubscriptionResponses(KUMA_SUBSCRIPTION, parameters, transport, now);
  assert.equal(first.requests, 2);
  assert.match(urls[0], /main%2Fa$/);
  const second = await fetchSubscriptionResponses(KUMA_SUBSCRIPTION, parameters, transport, now + 61, first.cache);
  assert.equal(second.requests, 1);
  assert.match(urls.at(-1)!, /heartbeat/);
});

test('304 reuses observations without modifying their source timestamps', async () => {
  const cached = { value: { services: [{ id: 'a', observedAt: 1 }] }, etag: '"one"', modified: null, fetchedAt: now - 100 };
  const result = await fetchSubscriptionResponses(JSON_SUBSCRIPTION, { baseUrl: parameters.baseUrl }, {
    validateUrl: async () => {}, fetch: async (_url, init) => { assert.equal(new Headers(init.headers).get('if-none-match'), '"one"'); return new Response(null, { status: 304 }); },
  }, now, { status: cached });
  assert.equal(result.cache.status.fetchedAt, now);
  assert.deepEqual(result.responses.status, cached.value);
});

test('a redirected POST never sends its secret body to another origin', async () => {
  const descriptor = structuredClone(JSON_SUBSCRIPTION);
  descriptor.inputs.token = { type: 'secret', required: true };
  descriptor.requests.status.method = 'POST';
  descriptor.requests.status.body = { token: '{token}' };
  let calls = 0;
  const result = await fetchSubscriptionResponses(descriptor, { baseUrl: parameters.baseUrl, token: 'secret' }, {
    validateUrl: async () => {}, fetch: async () => { calls++; return new Response(null, { status: 307, headers: { location: 'https://different.service.net/' } }); },
  }, now);
  assert.equal(calls, 1);
  assert.equal(result.failures[0].code, 'subscription_redirect_invalid');
});

test('oversized responses cancel the reader and do not become empty catalogs', async () => {
  await assert.rejects(readSubscriptionJson(Response.json({ data: 'a'.repeat(100) }), 20), { code: 'subscription_limit_exceeded' });
});

test('pagination has an explicit completion boundary', async () => {
  const descriptor = structuredClone(JSON_SUBSCRIPTION);
  descriptor.requests.status.pagination = { type: 'page', parameter: 'page', location: 'query', itemsPath: '$.services', maxPages: 2 };
  const result = await fetchSubscriptionResponses(descriptor, { baseUrl: parameters.baseUrl }, {
    validateUrl: async () => {}, fetch: async () => Response.json({ services: [{ id: 'a' }] }),
  }, now);
  assert.equal(result.requests, 2);
  assert.equal(result.failures[0].code, 'subscription_pagination_incomplete');
  assert.equal(result.responses.status, undefined);
});

test('private literals and non-HTTPS sources are refused before transport', () => {
  for (const url of ['http://status.service.net', 'https://127.0.0.1', 'https://[::ffff:7f00:1]', 'https://localhost', 'https://metadata.internal', 'https://user:pass@status.service.net', 'https://status.service.net:444']) assert.throws(() => publicSubscriptionUrl(url));
});

test('429 and 503 preserve bounded Retry-After; budget exhaustion is deferred', async () => {
  for (const status of [429, 503]) {
    const result = await fetchSubscriptionResponses(JSON_SUBSCRIPTION, { baseUrl: parameters.baseUrl }, { validateUrl: async () => {}, fetch: async () => new Response(null, { status, headers: { 'retry-after': '7200' } }) }, now);
    assert.equal(result.failures[0].retryAfterSec, 7200);
  }
  await assert.rejects(fetchSubscriptionResponses(JSON_SUBSCRIPTION, { baseUrl: parameters.baseUrl }, { validateUrl: async () => {}, reserve: () => { throw new SubscriptionError('subscription_budget_deferred', 503); }, fetch: async () => { throw new Error('must not fetch'); } }, now), { code: 'subscription_budget_deferred' });
});

test('cursor pagination omits the first cursor and follows the returned cursor', async () => {
  const descriptor = structuredClone(JSON_SUBSCRIPTION);
  descriptor.requests.status.pagination = { type: 'cursor', parameter: 'cursor', location: 'query', itemsPath: '$.services', nextPath: '$.next', maxPages: 2 };
  const cursors: (string | null)[] = [];
  const result = await fetchSubscriptionResponses(descriptor, { baseUrl: parameters.baseUrl }, { validateUrl: async () => {}, fetch: async url => { cursors.push(url.searchParams.get('cursor')); return Response.json({ services: [{ id: cursors.length }], next: cursors.length === 1 ? 'second' : null }); } }, now);
  assert.deepEqual(cursors, [null, 'second']); assert.equal(result.failures.length, 0);
});
