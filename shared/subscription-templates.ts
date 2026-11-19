import type { SubscriptionDescriptor } from './subscriptions';

export const OFFICIAL_SUBSCRIPTION_REPOSITORY = 'https://github.com/XingLingQAQ/UptimePolaris-Subscriptions';
export const OFFICIAL_SUBSCRIPTION_ROOT = 'https://raw.githubusercontent.com/XingLingQAQ/UptimePolaris-Subscriptions/main/';

export const KUMA_SUBSCRIPTION: SubscriptionDescriptor = {
  schemaVersion: 1, id: 'uptime-kuma', version: '1.0.1', name: 'Uptime Kuma',
  description: 'Public status page monitors and heartbeats.', categories: ['website', 'model'],
  capabilities: ['http-json', 'dictionary-join', 'heartbeat-history'],
  inputs: { baseUrl: { type: 'url', required: true }, slug: { type: 'string', required: true } },
  sourcePage: { baseUrlInput: 'baseUrl', path: '/status/{slug}' },
  requests: {
    catalog: { baseUrlInput: 'baseUrl', method: 'GET', path: '/api/status-page/{slug}', intervalSec: 300, response: 'json' },
    heartbeats: { baseUrlInput: 'baseUrl', method: 'GET', path: '/api/status-page/heartbeat/{slug}', intervalSec: 60, response: 'json' },
  },
  items: { request: 'catalog', path: '$.publicGroupList[*].monitorList[*]', fields: { id: '$.id', name: '$.name', group: { path: '$.name', from: 'parent' }, url: '$.url' } },
  observations: {
    request: 'heartbeats', path: '$.heartbeatList', lookupBy: 'item.id', mode: 'heartbeat', latestBy: '$.time',
    observedAt: { path: '$.time', format: 'yyyy-MM-dd HH:mm:ss[.SSS]', timeZone: 'UTC' },
    status: { path: '$.status', map: { '0': 'down', '1': 'up', '2': 'pending', '3': 'maintenance' }, fallback: 'unknown' },
    latency: { path: '$.ping', unit: 'ms' },
  },
  metrics: { availability: { request: 'heartbeats', path: '$.uptimeList', lookupBy: 'item.id', suffix: '_24', unit: 'ratio', windowSec: 86400 } },
};

export const STATUSPAGE_SUBSCRIPTION: SubscriptionDescriptor = {
  schemaVersion: 1, id: 'statuspage', version: '1.0.1', name: 'Statuspage',
  description: 'Current component status from a public Statuspage JSON endpoint.', categories: ['website', 'model'],
  capabilities: ['http-json', 'snapshot'], inputs: { baseUrl: { type: 'url', required: true } },
  sourcePage: { baseUrlInput: 'baseUrl', path: '/' },
  requests: { status: { baseUrlInput: 'baseUrl', method: 'GET', path: '/api/v2/summary.json', intervalSec: 60, response: 'json' } },
  items: { request: 'status', path: '$.components[*]', filter: { op: 'eq', path: '$.group', value: false }, fields: { id: '$.id', name: '$.name', group: '$.group_id' } },
  observations: {
    request: 'status', mode: 'snapshot', changedAt: { path: '$.updated_at', format: 'iso8601' },
    status: { path: '$.status', map: { operational: 'up', degraded_performance: 'degraded', partial_outage: 'degraded', major_outage: 'down', under_maintenance: 'maintenance' }, fallback: 'unknown' },
  },
};

export const JSON_SUBSCRIPTION: SubscriptionDescriptor = {
  schemaVersion: 1, id: 'json-website', version: '1.0.0', name: 'JSON website status',
  description: 'Map your JSON service list to website status.', categories: ['website'], capabilities: ['http-json', 'snapshot'],
  inputs: { baseUrl: { type: 'url', required: true } },
  requests: { status: { baseUrlInput: 'baseUrl', method: 'GET', path: '/status.json', intervalSec: 60, response: 'json' } },
  items: { request: 'status', path: '$.services[*]', fields: { id: '$.id', name: '$.name' } },
  observations: { request: 'status', mode: 'snapshot', status: { path: '$.status', map: { up: 'up', down: 'down', degraded: 'degraded', pending: 'pending', maintenance: 'maintenance', unknown: 'unknown' }, fallback: 'unknown' } },
};

export const POLARIS_WEBSITE_SUBSCRIPTION: SubscriptionDescriptor = {
  schemaVersion: 1, id: 'polaris-website', version: '1.0.2', name: 'Uptime Polaris websites',
  description: 'Published website monitors from another Polaris instance.', categories: ['website'], capabilities: ['http-json', 'snapshot'],
  sourcePage: { baseUrlInput: 'baseUrl', path: '/' },
  inputs: { baseUrl: { type: 'url', required: true } },
  requests: { status: { baseUrlInput: 'baseUrl', method: 'GET', path: '/api/public/status', query: { view: 'monitor' }, intervalSec: 60, response: 'json' } },
  items: { request: 'status', path: '$.monitors[*]', fields: { id: '$.id', name: '$.name', group: '$.group' } },
  observations: { request: 'status', mode: 'snapshot', currentWhen: { op: 'eq', path: '$.source_available', value: true }, status: { path: '$.st', map: { '0': 'down', '1': 'up', '2': 'degraded', '4': 'pending' }, fallback: 'unknown' }, latency: { path: '$.v', unit: 'ms' } },
};

export const POLARIS_MODEL_SUBSCRIPTION: SubscriptionDescriptor = {
  schemaVersion: 1, id: 'polaris-model', version: '1.0.2', name: 'Uptime Polaris models',
  description: 'Published model observations from another Polaris instance.', categories: ['model'], capabilities: ['http-json', 'heartbeat-history'],
  sourcePage: { baseUrlInput: 'baseUrl', path: '/ai' },
  inputs: { baseUrl: { type: 'url', required: true } },
  requests: { status: { baseUrlInput: 'baseUrl', method: 'GET', path: '/api/public/ai/models', query: { view: 'ai' }, intervalSec: 60, response: 'json' } },
  items: { request: 'status', path: '$.models[*]', fields: { id: '$.id', name: '$.name', provider: '$.channel.name' } },
  observations: { request: 'status', mode: 'heartbeat', currentWhen: { op: 'eq', path: '$.live.freshness', value: 'current' }, latestBy: '$.live.checkedAt', observedAt: { path: '$.live.checkedAt', format: 'unix-seconds' },
    status: { path: '$.live.outcome', map: { ok: 'up', rate_limited: 'degraded', quota_exhausted: 'down', authentication_failed: 'down', permission_denied: 'down', model_or_endpoint_unavailable: 'down', rate_limit_or_quota: 'degraded', upstream_unavailable: 'down', request_invalid: 'down', timeout: 'down', network_error: 'down', invalid_response: 'down', response_mismatch: 'down', unexpected_status: 'down' }, fallback: 'unknown' },
    latency: { path: '$.live.latencyMs', unit: 'ms' }, reason: '$.live.outcome' },
};

function site(id: string, name: string, url: string): SubscriptionDescriptor {
  return { ...structuredClone(STATUSPAGE_SUBSCRIPTION), id, name, categories: ['website'], inputs: { baseUrl: { type: 'url', required: true, default: url } } };
}

export const SUBSCRIPTION_TEMPLATES: SubscriptionDescriptor[] = [
  KUMA_SUBSCRIPTION, STATUSPAGE_SUBSCRIPTION, POLARIS_WEBSITE_SUBSCRIPTION, POLARIS_MODEL_SUBSCRIPTION, JSON_SUBSCRIPTION,
  { ...structuredClone(JSON_SUBSCRIPTION), id: 'json-model', name: 'JSON model status', description: 'Map your JSON model list to model status.', categories: ['model'], items: { request: 'status', path: '$.models[*]', fields: { id: '$.id', name: '$.name', modelId: '$.modelId', provider: '$.provider', protocol: '$.protocol' } } },
  site('github-status', 'GitHub Status', 'https://www.githubstatus.com'),
  site('cloudflare-status', 'Cloudflare Status', 'https://www.cloudflarestatus.com'),
];
