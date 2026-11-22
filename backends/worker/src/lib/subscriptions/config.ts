import type { Env } from '../../types';
import { publicSubscriptionUrl, subscriptionFileUrl, readSubscriptionJson, fetchSubscriptionResponses, type SubscriptionTransport } from '../../../../../shared/subscription-fetch';
import { parseSubscriptionResponses } from '../../../../../shared/subscription-parser';
import { redactSubscriptionItems, redactSubscriptionIssues } from '../../../../../shared/subscription-redaction';
import { subscriptionIdentityDiff } from '../../../../../shared/subscription-identity';
import { validateSubscriptionDescriptor } from '../../../../../shared/subscription-validation';
import { KUMA_SUBSCRIPTION, OFFICIAL_SUBSCRIPTION_ROOT } from '../../../../../shared/subscription-templates';
import { SUBSCRIPTION_LIMITS, SubscriptionError, type SubscriptionCatalogEntry, type SubscriptionConfig, type SubscriptionDescriptor, type SubscriptionPreview } from '../../../../../shared/subscriptions';
import { decryptSubscriptionSecrets, encryptSubscriptionSecrets } from './credentials';
import { SubscriptionStore } from './store';
import { ExternalBudgetExceeded, type ExternalRequestBudget } from '../http/request-budget';
import { validateSubscriptionDestination } from './egress';
import { parseSubscriptionCatalog } from '../../../../../shared/subscription-catalog';
import { repositoryEntries, type StoredSubscriptionRepository } from './repositories';
import { subscriptionPreviewParameters } from './source-page';

export interface StoredSubscriptionConfig extends SubscriptionConfig { ciphertext: string }
export interface StoredSubscriptionPreview extends SubscriptionPreview { owner: string; ciphertext: string; subscriptionId?: string; revision?: string }

export function subscriptionTransport(budget?: ExternalRequestBudget): SubscriptionTransport {
  const reserve = () => {
    try { budget?.reserve(); } catch (error) {
      if (error instanceof ExternalBudgetExceeded) throw new SubscriptionError('subscription_budget_deferred', 503);
      throw error;
    }
  };
  return { fetch: (url, init) => fetch(url, init), validateUrl: url => validateSubscriptionDestination(url, reserve), reserve };
}

interface RemoteDescriptor { descriptor: SubscriptionDescriptor; checkedAt: number; etag?: string | null; modified?: string | null }
async function readRemoteFile(url: string, transport = subscriptionTransport(), previous?: RemoteDescriptor | null): Promise<RemoteDescriptor> {
  let target = publicSubscriptionUrl(subscriptionFileUrl(url));
  let headers: Record<string, string> = { accept: 'application/json' };
  if (previous?.etag) headers['if-none-match'] = previous.etag;
  if (previous?.modified) headers['if-modified-since'] = previous.modified;
  const signal = AbortSignal.timeout(30000);
  for (let redirects = 0; redirects <= SUBSCRIPTION_LIMITS.redirects; redirects++) {
    await transport.validateUrl(target);
    transport.reserve?.();
    const response = await transport.fetch(target, { headers, redirect: 'manual', signal: AbortSignal.any([signal, AbortSignal.timeout(10000)]) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location) break;
      const next = publicSubscriptionUrl(new URL(location, target));
      if (next.origin !== target.origin) headers = { accept: 'application/json' };
      target = next; continue;
    }
    if (response.status === 304 && previous) { await response.body?.cancel(); return { ...previous, checkedAt: Math.floor(Date.now() / 1000) }; }
    if (!response.ok) { await response.body?.cancel(); throw new SubscriptionError('subscription_fetch_failed', 502); }
    if (response.headers.get('content-type')?.includes('text/html')) { await response.body?.cancel(); throw new SubscriptionError('subscription_json_link_required'); }
    return { descriptor: validateSubscriptionDescriptor((await readSubscriptionJson(response, SUBSCRIPTION_LIMITS.descriptorBytes)).value), checkedAt: Math.floor(Date.now() / 1000), etag: response.headers.get('etag'), modified: response.headers.get('last-modified') };
  }
  throw new SubscriptionError('subscription_redirect_invalid', 502);
}
export async function readRemoteDescriptor(url: string, transport = subscriptionTransport()): Promise<SubscriptionDescriptor> { return (await readRemoteFile(url, transport)).descriptor; }

export async function cachedRemoteDescriptor(store: SubscriptionStore, url: string, force = false): Promise<SubscriptionDescriptor> {
  const key = subscriptionFileUrl(url), now = Math.floor(Date.now() / 1000);
  const previous = await store.document<RemoteDescriptor>('remote-file', key);
  if (previous && now - previous.checkedAt < (force ? 60 : 86400)) return previous.descriptor;
  const result = await readRemoteFile(key, subscriptionTransport(), previous);
  await store.putDocument('remote-file', key, result, null, now + 7 * 86400);
  return result.descriptor;
}

export async function checkSubscriptionUpdate(store: SubscriptionStore, config: StoredSubscriptionConfig, subscriptionId: string, force = false) {
  const now = Math.floor(Date.now() / 1000);
  type Update = { checkedAt: number; version: string | null; changed: boolean; conflict: boolean; error: string | null; candidate?: SubscriptionDescriptor; sourceUrl?: string };
  const cached = await store.document<Update>('config-update', config.id);
  if (cached && now - cached.checkedAt < (force ? 60 : 86400)) return cached;
  if (!config.sourceUrl) throw new SubscriptionError('subscription_update_source_missing');
  let update: Update;
  try {
    let sourceUrl = config.sourceUrl;
    if (config.origin === 'official') {
      const catalog = await subscriptionCatalog(store, force), entry = catalog.entries.find(entry => entry.id === config.descriptor.id);
      if (catalog.stale || !entry) throw new SubscriptionError('subscription_catalog_unavailable', 502);
      sourceUrl = new URL(entry.path, OFFICIAL_SUBSCRIPTION_ROOT).href;
    }
    const candidate = await cachedRemoteDescriptor(store, sourceUrl, force);
    if (candidate.id !== config.descriptor.id) throw new SubscriptionError('subscription_version_conflict', 409);
    const changed = JSON.stringify(candidate) !== JSON.stringify(config.descriptor);
    update = { checkedAt: now, version: candidate.version, changed, conflict: changed && candidate.version === config.descriptor.version, candidate, sourceUrl, error: null };
  } catch (error) {
    update = { checkedAt: now, version: cached?.version ?? null, changed: cached?.changed ?? false, conflict: cached?.conflict ?? false, candidate: cached?.candidate, error: error instanceof SubscriptionError ? error.code : 'subscription_fetch_failed' };
  }
  await store.putDocument('config-update', config.id, update, subscriptionId);
  return update;
}

export function configView(config: StoredSubscriptionConfig): SubscriptionConfig {
  const { ciphertext: _ciphertext, ...view } = config;
  return view;
}
export function previewView(preview: StoredSubscriptionPreview): SubscriptionPreview {
  const { ciphertext: _ciphertext, owner: _owner, ...view } = preview;
  return view;
}

export async function createSubscriptionPreview(store: SubscriptionStore, env: Env, input: {
  descriptor: unknown; parameters: unknown; sourceUrl?: string | null; origin?: 'official' | 'local'; subscriptionId?: string; revision?: string; modified?: boolean;
}, owner: string, transport = subscriptionTransport(), defer?: (work: Promise<unknown>) => void): Promise<StoredSubscriptionPreview> {
  const descriptor = validateSubscriptionDescriptor(input.descriptor);
  const parameters = await subscriptionPreviewParameters(descriptor, input.parameters, transport);
  const id = crypto.randomUUID(), now = Math.floor(Date.now() / 1000);
  const secrets: Record<string, string | number | boolean> = {}, ordinary: Record<string, string | number | boolean> = {};
  for (const [name, value] of Object.entries(parameters)) (descriptor.inputs[name].type === 'secret' ? secrets : ordinary)[name] = value;
  const ciphertext = await encryptSubscriptionSecrets(secrets, id, env.ADMIN_TOKEN);
  const sourceUrl = input.sourceUrl ? publicSubscriptionUrl(input.sourceUrl).href : null;
  const config: SubscriptionConfig = { id, descriptor, parameters: ordinary, secretNames: Object.keys(secrets), sourceUrl, origin: input.origin ?? 'local', modified: input.modified ?? false, fetchedAt: now };
  const preview: StoredSubscriptionPreview = { id, owner, ciphertext, config, state: 'running', items: [], issues: [], createdAt: now, expiresAt: now + SUBSCRIPTION_LIMITS.previewSec, error: null, subscriptionId: input.subscriptionId, revision: input.revision };
  await store.putDocument('preview', id, preview, input.subscriptionId ?? null, preview.expiresAt);
  const complete = async () => {
  try {
    const fetched = await fetchSubscriptionResponses(descriptor, parameters, transport, now);
    const parsed = parseSubscriptionResponses(descriptor, fetched.responses, now);
    preview.items = redactSubscriptionItems(parsed.items, secrets);
    if (input.subscriptionId) {
      const subscription = await store.get(input.subscriptionId);
      const previous = await store.document<StoredSubscriptionConfig>('config', subscription.configId);
      if (previous) preview.identity = subscriptionIdentityDiff(previous, config, await store.items(subscription.id), preview.items.map(item => item.sourceItemId));
    }
    preview.issues = redactSubscriptionIssues([...fetched.failures.map(issue => ({ ...issue, path: '$' })), ...parsed.issues], secrets);
    preview.state = preview.issues.length ? parsed.items.length ? 'partial' : 'failed' : 'ready';
    if (preview.state === 'failed') preview.error = 'subscription_preview_failed';
  } catch (error) {
    preview.state = 'failed'; preview.error = error instanceof SubscriptionError ? error.code : 'subscription_fetch_failed';
  }
    await store.putDocument('preview', id, preview, input.subscriptionId ?? null, preview.expiresAt);
    return preview;
  };
  if (defer) { const queued = structuredClone(preview); defer(complete()); return queued; }
  return complete();
}

export async function previewConfig(preview: StoredSubscriptionPreview, env: Env, id: string): Promise<StoredSubscriptionConfig> {
  const secrets = await decryptSubscriptionSecrets(preview.ciphertext, preview.id, env.ADMIN_TOKEN);
  return { ...preview.config, id, ciphertext: await encryptSubscriptionSecrets(secrets, id, env.ADMIN_TOKEN) };
}

export async function subscriptionCatalog(store: SubscriptionStore, refresh = false): Promise<{ entries: SubscriptionCatalogEntry[]; fetchedAt: number | null; stale: boolean; error: string | null }> {
  const now = Math.floor(Date.now() / 1000);
  const cached = await store.document<{ entries: SubscriptionCatalogEntry[]; fetchedAt: number }>('catalog', 'official');
  if (cached && now - cached.fetchedAt < (refresh ? 60 : 21600)) return { ...cached, stale: false, error: null };
  try {
    await validateSubscriptionDestination(new URL(`${OFFICIAL_SUBSCRIPTION_ROOT}catalog.json`));
    const response = await fetch(`${OFFICIAL_SUBSCRIPTION_ROOT}catalog.json`, { redirect: 'manual', signal: AbortSignal.timeout(10000), headers: { accept: 'application/json' } });
    if (!response.ok) throw new SubscriptionError('subscription_catalog_unavailable', 502);
    const entries = parseSubscriptionCatalog((await readSubscriptionJson(response, SUBSCRIPTION_LIMITS.catalogBytes)).value);
    await store.putDocument('catalog', 'official', { entries, fetchedAt: now });
    return { entries, fetchedAt: now, stale: false, error: null };
  } catch {
    const builtin: SubscriptionCatalogEntry = { id: KUMA_SUBSCRIPTION.id, name: KUMA_SUBSCRIPTION.name, description: KUMA_SUBSCRIPTION.description, categories: KUMA_SUBSCRIPTION.categories, kind: 'template', version: KUMA_SUBSCRIPTION.version, path: `templates/uptime-kuma/${KUMA_SUBSCRIPTION.version}.json`, capabilities: KUMA_SUBSCRIPTION.capabilities, verifiedAt: null, limitations: [], origin: 'official' };
    return { entries: cached?.entries ?? [builtin], fetchedAt: cached?.fetchedAt ?? null, stale: true, error: 'subscription_catalog_unavailable' };
  }
}

export async function catalogDescriptor(store: SubscriptionStore, id: string): Promise<{ descriptor: SubscriptionDescriptor; sourceUrl: string | null; origin: 'official' | 'local' }> {
  if (/^repo-[a-f0-9]{32}:/.test(id)) {
    const repository = await store.document<StoredSubscriptionRepository>('repository', id.split(':')[0]);
    const entry = repository && repositoryEntries(repository).find(entry => entry.id === id);
    if (!entry?.sourceUrl) throw new SubscriptionError('not_found', 404);
    const descriptor = await cachedRemoteDescriptor(store, entry.sourceUrl);
    if (descriptor.id !== id.split(':')[1] || descriptor.version !== entry.version) throw new SubscriptionError('subscription_version_conflict', 409);
    return { descriptor, sourceUrl: entry.sourceUrl, origin: 'local' };
  }
  if (id.startsWith('local-')) {
    const local = await store.document<{ descriptor: SubscriptionDescriptor; sourceUrl: string | null }>('library', id);
    if (!local) throw new SubscriptionError('not_found', 404);
    return { ...local, origin: 'local' };
  }
  const catalog = await subscriptionCatalog(store), entry = catalog.entries.find(item => item.id === id);
  if (!entry) throw new SubscriptionError('not_found', 404);
  const sourceUrl = new URL(entry.path, OFFICIAL_SUBSCRIPTION_ROOT).href;
  const cached = await store.document<SubscriptionDescriptor>('template', `${id}:${entry.version}`);
  if (cached) return { descriptor: cached, sourceUrl, origin: 'official' };
  let descriptor: SubscriptionDescriptor;
  if (id === 'uptime-kuma' && entry.version === KUMA_SUBSCRIPTION.version) descriptor = structuredClone(KUMA_SUBSCRIPTION);
  else descriptor = await readRemoteDescriptor(sourceUrl);
  if (descriptor.id !== entry.id || descriptor.version !== entry.version) throw new SubscriptionError('subscription_version_conflict', 409);
  await store.putDocument('template', `${id}:${entry.version}`, descriptor);
  return { descriptor, sourceUrl, origin: 'official' };
}
