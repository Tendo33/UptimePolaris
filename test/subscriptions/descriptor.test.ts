import assert from 'node:assert/strict';
import { test } from 'node:test';
import { subscriptionPath } from '../../shared/subscription-path';
import { parseSubscriptionResponses } from '../../shared/subscription-parser';
import { validateSubscriptionDescriptor, subscriptionParameters } from '../../shared/subscription-validation';
import { KUMA_SUBSCRIPTION, STATUSPAGE_SUBSCRIPTION, SUBSCRIPTION_TEMPLATES, POLARIS_MODEL_SUBSCRIPTION } from '../../shared/subscription-templates';
import { subscriptionTime } from '../../shared/subscription-parser';
import { redactSubscriptionItems } from '../../shared/subscription-redaction';
import { subscriptionSourcePage } from '../../shared/subscription-fetch';
import { subscriptionIdentity } from '../../shared/subscription-identity';
import { selectableSubscriptionItem, type SubscriptionConfig } from '../../shared/subscriptions';

test('all supplied templates satisfy the descriptor contract', () => {
  for (const template of SUBSCRIPTION_TEMPLATES) assert.equal(validateSubscriptionDescriptor(template), template);
});

test('source pages encode slug values and reject secret references', () => {
  assert.equal(subscriptionSourcePage(KUMA_SUBSCRIPTION, {baseUrl:'https://status.service.net',slug:'public page'}), 'https://status.service.net/status/public%20page');
  const descriptor=structuredClone(KUMA_SUBSCRIPTION);
  descriptor.inputs.slug.type='secret';
  assert.throws(()=>validateSubscriptionDescriptor(descriptor));
});

test('changing a directory parameter changes identity while rotating a credential does not', () => {
  const config = { descriptor: structuredClone(KUMA_SUBSCRIPTION), parameters: { baseUrl:'https://status.service.net',slug:'main' } } as SubscriptionConfig;
  assert.notEqual(subscriptionIdentity(config), subscriptionIdentity({...config,parameters:{...config.parameters,slug:'other'}}));
  config.descriptor.inputs.token={type:'secret'};
  config.descriptor.requests.catalog.headers={authorization:'Bearer {token}'};
  assert.equal(subscriptionIdentity(config),subscriptionIdentity({...config,parameters:{...config.parameters,token:'rotated'}}));
});

test('nested credential literals, malformed headers and hidden mapping paths are rejected', () => {
  const descriptor = structuredClone(STATUSPAGE_SUBSCRIPTION);
  descriptor.requests.status.method = 'POST';
  descriptor.requests.status.body = { auth: [{ api_key: 'private-value' }] };
  assert.throws(() => validateSubscriptionDescriptor(descriptor));
  descriptor.inputs.token = { type: 'secret' };
  descriptor.requests.status.body = { auth: [{ api_key: '{token}' }], max_tokens: 100 };
  validateSubscriptionDescriptor(descriptor);
  descriptor.requests.status.headers = { 'invalid header': 'value' };
  assert.throws(() => validateSubscriptionDescriptor(descriptor));
  delete descriptor.requests.status.headers;
  descriptor.items.filter = { op: 'and', conditions: [{ op: 'exists', path: '$.__proto__' }] };
  assert.throws(() => validateSubscriptionDescriptor(descriptor));
});

test('Polaris models preserve upstream stale state despite a recent successful observation', () => {
  const now = Math.floor(Date.now()/1000);
  const result = parseSubscriptionResponses(POLARIS_MODEL_SUBSCRIPTION, { status: { models: [{id:'model',name:'Model',live:{checkedAt:now-5,outcome:'ok',freshness:'stale'}}] } }, now);
  assert.equal(result.items[0].sourceCurrent, false);
});

test('invalid calendar dates cannot roll over into a valid observation', () => {
  assert.equal(subscriptionTime('2026-02-31T00:00:00Z', { path: '$', format: 'iso8601' }, Date.parse('2026-11-20') / 1000), null);
});

test('mapped source fields cannot reveal supplied credentials', () => {
  const parsed = parseSubscriptionResponses(STATUSPAGE_SUBSCRIPTION, { status: { components: [{ id: 'a', name: 'api-secret-token', group: false, status: 'operational', updated_at: '2026-11-19T00:00:00Z' }] } }, Date.parse('2026-11-20') / 1000);
  assert.equal(redactSubscriptionItems(parsed.items, { token: 'secret-token' })[0].name, 'api-[redacted]');
  assert.throws(() => redactSubscriptionItems([{ ...parsed.items[0], sourceItemId: 'secret-token' }], { token: 'secret-token' }));
});

test('paths carry group context without evaluating code or inherited properties', () => {
  const root = { groups: [{ name: 'API', monitors: [{ id: 1 }] }] };
  assert.deepEqual(subscriptionPath(root, '$.groups[*].monitors[*]').map(row => [row.value, row.parent]), [[{ id: 1 }, root.groups[0]]]);
  assert.throws(() => subscriptionPath(root, '$.__proto__'));
  assert.throws(() => subscriptionPath(root, '$.groups[?(@.id)]'));
  assert.deepEqual(subscriptionPath(Object.create({ hidden: 'secret' }), '$.hidden'), []);
});

test('unknown descriptor fields, missing references and secret defaults are rejected', () => {
  assert.throws(() => validateSubscriptionDescriptor({ ...KUMA_SUBSCRIPTION, script: 'alert(1)' }));
  assert.throws(() => validateSubscriptionDescriptor({ ...KUMA_SUBSCRIPTION, observations: { ...KUMA_SUBSCRIPTION.observations, request: 'missing' } }));
  assert.throws(() => validateSubscriptionDescriptor({ ...KUMA_SUBSCRIPTION, inputs: { ...KUMA_SUBSCRIPTION.inputs, token: { type: 'secret', default: 'token' } } }));
  assert.throws(() => subscriptionParameters(KUMA_SUBSCRIPTION, { baseUrl: 'http://example.com', slug: 'main' }));
  assert.throws(() => subscriptionParameters(KUMA_SUBSCRIPTION, { baseUrl: 'https://example.com', slug: 'main', unknown: true }));
});

const now = Date.parse('2026-11-20T00:00:00Z') / 1000;
function kuma(ids = [1, 2, 3]) {
  return {
    catalog: { publicGroupList: [{ name: 'Core', monitorList: ids.map(id => ({ id, name: `Service ${id}` })) }] },
    heartbeats: { heartbeatList: {
      '1': [{ status: 1, time: '2026-11-19 23:59:00', ping: 0 }],
      '2': [{ status: 2, time: '2026-11-19 23:59:00', ping: null }],
      '3': [{ status: 3, time: '2026-11-19 23:59:00', ping: null }],
    }, uptimeList: { '1_24': 0.999 } },
  };
}

test('Kuma retains pending, maintenance, null latency and ratio units', () => {
  const result = parseSubscriptionResponses(KUMA_SUBSCRIPTION, kuma(), now);
  assert.equal(result.complete, true);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.items.map(item => item.observation?.status), ['up', 'pending', 'maintenance']);
  assert.equal(result.items[0].group, 'Core');
  assert.equal(result.items[0].observation?.latencyMs, 0);
  assert.equal(result.items[1].observation?.latencyMs, null);
  assert.equal(result.items[0].availability?.value, 99.9);
});

test('missing catalogs are errors, complete empty catalogs remain valid', () => {
  assert.throws(() => parseSubscriptionResponses(KUMA_SUBSCRIPTION, { catalog: {}, heartbeats: {} }, now));
  assert.deepEqual(parseSubscriptionResponses(KUMA_SUBSCRIPTION, { catalog: { publicGroupList: [] }, heartbeats: {} }, now).items, []);
});

test('duplicate IDs do not silently attach state to the wrong item', () => {
  const result = parseSubscriptionResponses(KUMA_SUBSCRIPTION, kuma([1, 1]), now);
  assert.equal(result.complete, false);
  assert.deepEqual(result.items, []);
  assert.equal(result.issues[0].code, 'subscription_item_duplicate');
});

test('source update time is not a snapshot observation time', () => {
  const result = parseSubscriptionResponses(STATUSPAGE_SUBSCRIPTION, { status: { components: [
    { id: 'group', name: 'Group', group: true },
    { id: 'api', name: 'API', group: false, status: 'operational', updated_at: '2020-01-01T00:00:00Z' },
  ] } }, now);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].observation?.observedAt, null);
  assert.equal(result.items[0].observation?.changedAt, Date.parse('2020-01-01T00:00:00Z') / 1000);
  assert.equal(result.items[0].observation?.fetchedAt, now);
});

test('unknown statuses are visible issues, not healthy fallback values', () => {
  const data = kuma();
  data.heartbeats.heartbeatList['1'][0].status = 99;
  const result = parseSubscriptionResponses(KUMA_SUBSCRIPTION, data, now);
  assert.equal(result.items[0].observation?.status, 'unknown');
  assert.equal(result.issues[0].code, 'subscription_status_unknown');
  assert.equal(selectableSubscriptionItem(result.items[0], result.issues), false);
  assert.equal(selectableSubscriptionItem(result.items[1], result.issues), true);
});
