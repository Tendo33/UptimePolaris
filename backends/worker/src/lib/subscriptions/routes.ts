import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { SubscriptionError, selectableSubscriptionItem, subscriptionNotifications, subscriptionRuntime, type Subscription, type SubscriptionCategory, type SubscriptionItem, type SubscriptionNotificationPolicy, type SubscriptionDescriptor, type SubscriptionCatalogEntry } from '../../../../../shared/subscriptions';
import { subscriptionItemView, mergeSubscriptionItem } from '../../../../../shared/subscription-runtime';
import { validateSubscriptionDescriptor } from '../../../../../shared/subscription-validation';
import { subscriptionCredentialBindings, subscriptionFileUrl, subscriptionSourcePage } from '../../../../../shared/subscription-fetch';
import { subscriptionIdentity, remapSubscriptionIdentities } from '../../../../../shared/subscription-identity';
import { notificationChannelIds } from '../../../../../shared/notification-routing';
import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { safeEqual } from '../auth/service';
import { currentUser } from '../auth/routes';
import { requestPage } from '../presentation/context';
import { loadPresentation } from '../presentation/store';
import { SubscriptionStore } from './store';
import { checkSubscriptionUpdate, cachedRemoteDescriptor, catalogDescriptor, configView, createSubscriptionPreview, previewConfig, previewView, subscriptionCatalog, type StoredSubscriptionConfig, type StoredSubscriptionPreview } from './config';
import { decryptSubscriptionSecrets } from './credentials';
import { newSubscriptionItem, runSubscription, subscriptionRunView, type SubscriptionRun } from './runtime';
import { subscriptionHealth, type SubscriptionSummary } from '../../../../../shared/subscriptions';
import { subscriptionIcon } from './icon';
import { readSetting } from '../settings/store';

export const subscriptionRoutes = new Hono<{ Bindings: Env }>();
subscriptionRoutes.use('/api/admin/subscription*', bodyLimit({ maxSize: 300000, onError: c => c.json({ error: 'subscription_limit_exceeded' }, 413) }));
subscriptionRoutes.use('/api/admin/subscription*', async (c, next) => {
  c.header('cache-control', 'private, no-store');
  if (!['GET', 'HEAD'].includes(c.req.method)) {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    if (!(c.env.ADMIN_TOKEN && safeEqual(token, c.env.ADMIN_TOKEN))) {
      const origin = c.req.header('origin');
      if (origin ? origin !== new URL(c.req.url).origin : c.req.header('sec-fetch-site') === 'cross-site') return c.json({ error: 'invalid_origin' }, 403);
    }
  }
  await next();
});
subscriptionRoutes.onError((error, c) => error instanceof SubscriptionError ? c.json({ error: error.code, issues: error.issues }, error.status) : c.json({ error: 'subscription_storage_unavailable' }, 503));

const object = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SubscriptionError('invalid_request');
  return value as Record<string, unknown>;
};
const now = () => Math.floor(Date.now() / 1000);
const text = (value: unknown, limit = 120): string => {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) throw new SubscriptionError('invalid_request');
  return value.trim();
};
const integer = (value: unknown, min: number, max: number): number => {
  if (!Number.isSafeInteger(value) || Number(value) < min || Number(value) > max) throw new SubscriptionError('invalid_request');
  return Number(value);
};
const category = (value: unknown): SubscriptionCategory => { if (value !== 'website' && value !== 'model') throw new SubscriptionError('invalid_request'); return value; };
function checkRevision(subscription: Subscription, body: Record<string, unknown>): void {
  if (subscription.revision !== body.revision) throw new SubscriptionError('revision_conflict', 409);
}
function page<T>(rows: T[], offsetValue: string | undefined, limitValue: string | undefined) {
  const offset = offsetValue === undefined ? 0 : integer(Number(offsetValue), 0, 100000);
  const limit = limitValue === undefined ? 50 : integer(Number(limitValue), 1, 200);
  return { items: rows.slice(offset, offset + limit), total: rows.length, nextOffset: offset + limit < rows.length ? offset + limit : null };
}

async function policy(store: SubscriptionStore, value: unknown): Promise<SubscriptionNotificationPolicy> {
  const input = object(value), ids = notificationChannelIds(input.notificationChannelIds);
  if (typeof input.notificationEnabled !== 'boolean' || !ids) throw new SubscriptionError('invalid_request');
  for (const id of ids) if (!await store.db.queryOne(store.sql('SELECT id FROM notifications WHERE id=?'), [id])) throw new SubscriptionError('notification_channel_not_found');
  return { notificationEnabled: input.notificationEnabled, notificationChannelIds: ids };
}
async function owner(c: Context<{ Bindings: Env }>): Promise<string> {
  const user = await currentUser(c);
  return user.user ? String(user.user.id) : 'admin-token';
}

subscriptionRoutes.get('/api/admin/subscription-catalog', async c => {
  const store = new SubscriptionStore(getDB(c.env)), catalog = await subscriptionCatalog(store);
  const subscriptions = await store.list();
  const installed = (await Promise.all(subscriptions.map(row => store.document<StoredSubscriptionConfig>('config', row.configId)))).filter(config => config !== null);
  const entries = catalog.entries.map(entry => ({ ...entry, installedCount: installed.filter(config => config.origin === 'official' && config.descriptor.id === entry.id).length }));
  const local = await store.documents<{ id: string; descriptor: SubscriptionDescriptor; sourceUrl: string | null; fetchedAt: number }>('library', undefined, 500);
  const imported: SubscriptionCatalogEntry[] = local.map(row => ({ id: row.id, name: row.descriptor.name, description: row.descriptor.description, version: row.descriptor.version, categories: row.descriptor.categories, kind: 'template', path: '', capabilities: row.descriptor.capabilities, verifiedAt: null, limitations: [], origin: 'local', installedCount: installed.filter(config => config.origin === 'local' && config.descriptor.id === row.descriptor.id && config.sourceUrl === row.sourceUrl).length }));
  return c.json({ ...catalog, entries: [...entries, ...imported] });
});
subscriptionRoutes.post('/api/admin/subscription-catalog/refresh', async c => c.json(await subscriptionCatalog(new SubscriptionStore(getDB(c.env)), true)));
subscriptionRoutes.get('/api/admin/subscription-catalog/:templateId', async c => c.json(await catalogDescriptor(new SubscriptionStore(getDB(c.env)), c.req.param('templateId'))));

subscriptionRoutes.post('/api/admin/subscription-configs/import', async c => {
  const body = object(await c.req.json());
  const store = new SubscriptionStore(getDB(c.env));
  const count = await store.db.queryOne<{ total: number }>("SELECT COUNT(*) AS total FROM subscription_documents WHERE kind='library'");
  if (Number(count?.total) >= 500) throw new SubscriptionError('subscription_limit_exceeded', 413);
  const descriptor = body.url ? await cachedRemoteDescriptor(store, text(body.url, 2048)) : validateSubscriptionDescriptor(body.descriptor);
  const id = `local-${crypto.randomUUID()}`, sourceUrl = typeof body.url === 'string' ? subscriptionFileUrl(body.url) : null;
  await store.putDocument('library', id, { id, descriptor, sourceUrl, fetchedAt: now() });
  return c.json({ id, descriptor, sourceUrl, origin: 'local' });
});
subscriptionRoutes.delete('/api/admin/subscription-configs/:configId', async c => {
  const store = new SubscriptionStore(getDB(c.env)), id = c.req.param('configId');
  if (!id.startsWith('local-')) throw new SubscriptionError('invalid_request');
  await store.db.execute(store.sql("DELETE FROM subscription_documents WHERE kind='library' AND id=?"), [id]);
  return c.json({ ok: true });
});
subscriptionRoutes.post('/api/admin/subscription-configs/preview', async c => {
  const body = object(await c.req.json()), store = new SubscriptionStore(getDB(c.env));
  const imported = body.templateId ? await catalogDescriptor(store, text(body.templateId, 64)) : { descriptor: validateSubscriptionDescriptor(body.descriptor), sourceUrl: typeof body.sourceUrl === 'string' ? body.sourceUrl : null, origin: 'local' as const };
  const preview = await createSubscriptionPreview(store, c.env, { ...imported, parameters: body.parameters ?? {} }, await owner(c), undefined, work => c.executionCtx.waitUntil(work));
  return c.json({ preview: previewView(preview), previewId: preview.id }, 202);
});
subscriptionRoutes.get('/api/admin/subscription-previews/:previewId', async c => {
  const preview = await new SubscriptionStore(getDB(c.env)).document<StoredSubscriptionPreview>('preview', c.req.param('previewId'));
  if (!preview || preview.owner !== await owner(c)) throw new SubscriptionError('subscription_preview_expired', 409);
  return c.json({ preview: previewView(preview) });
});

subscriptionRoutes.get('/api/admin/subscriptions', async c => {
  const store = new SubscriptionStore(getDB(c.env));
  let rows = await store.list();
  const kind = c.req.query('category');
  if (kind) rows = rows.filter(row => row.category === category(kind));
  if (c.req.query('archived') !== 'true') rows = rows.filter(row => row.archivedAt === null);
  const selectedCounts = await store.selectedCounts();
  const summary: SubscriptionSummary = { total: rows.length, items: 0, healthy: 0, partial: 0, failed: 0, paused: 0, archived: 0 };
  for (const row of rows) { summary[subscriptionHealth(row)]++; summary.items += selectedCounts.get(row.id) ?? 0; }
  const query = c.req.query('q')?.toLowerCase();
  if (query) rows = rows.filter(row => row.name.toLowerCase().includes(query));
  const health = c.req.query('health');
  if (health && health !== 'all') rows = rows.filter(row => subscriptionHealth(row) === health);
  const result = page(rows, c.req.query('offset'), c.req.query('limit'));
  result.items = await Promise.all(result.items.map(async row => {
    const statusCounts = await store.statusCounts(row);
    return { ...row, statusCounts, runtime: { ...row.runtime, selectedCount: Object.values(statusCounts).reduce((sum, count) => sum + count, 0) } };
  }));
  const due: Subscription[] = [];
  for (const row of result.items) {
    const update = await store.document<NonNullable<Subscription['configUpdate']>>('config-update', row.configId);
    if (update) { const { checkedAt, version, changed, conflict, error } = update; row.configUpdate = { checkedAt, version, changed, conflict, error }; }
    if (row.sourceUrl && (!update || now() - update.checkedAt >= 86400)) due.push(row);
  }
  c.executionCtx.waitUntil((async () => {
    for (const row of due.slice(0, 2)) {
      const config = await store.document<StoredSubscriptionConfig>('config', row.configId);
      if (config) await checkSubscriptionUpdate(store, config, row.id);
    }
  })().catch(() => {}));
  return c.json({ ...result, summary });
});
subscriptionRoutes.post('/api/admin/subscriptions', async c => {
  const body = object(await c.req.json()), store = new SubscriptionStore(getDB(c.env));
  const requestId = text(body.requestId, 64), principal = await owner(c);
  const replay = await store.document<{ id: string; owner: string }>('create-request', requestId);
  if (replay) {
    if (replay.owner !== principal) throw new SubscriptionError('revision_conflict', 409);
    return c.json({ subscription: await store.get(replay.id) });
  }
  const preview = await store.document<StoredSubscriptionPreview>('preview', text(body.previewId, 64));
  if (!preview || preview.owner !== principal || !['ready', 'partial'].includes(preview.state)) throw new SubscriptionError('subscription_preview_expired', 409);
  const kind = category(body.category);
  if (!preview.config.descriptor.categories.includes(kind)) throw new SubscriptionError('subscription_category_invalid');
  if (kind === 'model' && !(await loadPresentation(c.env)).config.aiEnabled) throw new SubscriptionError('ai_disabled', 409);
  if (!Array.isArray(body.selectedIds) || !body.selectedIds.length || body.selectedIds.some(id => typeof id !== 'string' || !preview.items.some(item => item.sourceItemId === id && selectableSubscriptionItem(item, preview.issues)))) throw new SubscriptionError('subscription_selection_invalid');
  const id = crypto.randomUUID(), stamp = now(), revision = crypto.randomUUID();
  const config = await previewConfig(preview, c.env, crypto.randomUUID());
  const sourceHosts = [...new Set(Object.values(config.descriptor.requests).map(request => new URL(String(config.parameters[request.baseUrlInput] ?? config.descriptor.inputs[request.baseUrlInput]?.default)).hostname))];
  const subscription: Subscription = { id, name: text(body.name), category: kind, enabled: true, archivedAt: null, isPublic: body.isPublic === true,
    autoSubscribe: body.autoSubscribe === true, intervalSec: body.intervalSec === undefined ? 60 : integer(body.intervalSec, 60, 86400), staleAfterSec: body.staleAfterSec === undefined ? 300 : integer(body.staleAfterSec, 60, 604800),
    revision, syncRevision: revision, configId: config.id, templateName: config.descriptor.name, templateVersion: config.descriptor.version, sourceUrl: config.sourceUrl, origin: config.origin,
    createdAt: stamp, updatedAt: stamp, notifications: subscriptionNotifications(), runtime: subscriptionRuntime(), sourceHosts, sourcePageUrl: subscriptionSourcePage(config.descriptor, config.parameters) };
  if (body.notifications) {
    const supplied = object(body.notifications);
    subscription.notifications.monitor = await policy(store, supplied.monitor);
    subscription.notifications.sync = { ...await policy(store, supplied.sync), afterSec: integer(object(supplied.sync).afterSec ?? 300, 60, 86400) };
  }
  const selected = new Set(body.selectedIds);
  const groupId = body.groupId ? text(body.groupId, 64) : null;
  if (groupId && (kind !== 'website' || !await store.db.queryOne(store.sql('SELECT id FROM monitor_groups WHERE id=?'), [groupId]))) throw new SubscriptionError('group_not_found');
  const items = preview.items.map(source => {
    const item = newSubscriptionItem(source, subscription, selected.has(source.sourceItemId));
    const merged = mergeSubscriptionItem(item, source, subscription.syncRevision, stamp);
    return { ...merged, groupId, isPublic: subscription.isPublic && item.selected, baseline: true, announced: merged.observation?.status ?? null };
  });
  subscription.runtime.itemCount = items.length; subscription.runtime.selectedCount = selected.size;
  try {
    await store.create(subscription, [store.documentWrite('config', config.id, config, id), store.write("INSERT INTO subscription_documents(kind,id,subscription_id,json,expires_at) VALUES('create-request',?,?,?,?)", [requestId, id, JSON.stringify({ id, owner: principal }), stamp + 86400])], items);
  } catch (error) {
    const replay = await store.document<{ id: string; owner: string }>('create-request', requestId);
    if (!replay || replay.owner !== principal) throw error;
    return c.json({ subscription: await store.get(replay.id) });
  }
  return c.json({ subscription }, 201);
});
subscriptionRoutes.get('/api/admin/subscriptions/:id', async c => {
  const store = new SubscriptionStore(getDB(c.env)), subscription = await store.get(c.req.param('id'));
  const statusCounts = await store.statusCounts(subscription);
  return c.json({ subscription: { ...subscription, statusCounts, runtime: { ...subscription.runtime, selectedCount: Object.values(statusCounts).reduce((sum, count) => sum + count, 0) } } });
});
for (const admin of [true, false]) subscriptionRoutes.get(admin ? '/api/admin/subscriptions/:id/icon' : '/api/public/subscriptions/icons/:id', async c => {
  c.header('cache-control', 'private, no-store');
  const store = new SubscriptionStore(getDB(c.env)), subscription = await store.get(c.req.param('id'));
  if (!admin) {
    if (!subscription.isPublic || subscription.archivedAt !== null || !await publicAllowed(c.env, c.req.raw, subscription.category)) throw new SubscriptionError('not_found', 404);
    if (!(await store.itemIndex(subscription.id, true)).some(item => item.removedAt === null)) throw new SubscriptionError('not_found', 404);
  }
  if (!await readSetting(c.env, 'site.syncMonitorIcons')) throw new SubscriptionError('not_found', 404);
  const icon = await subscriptionIcon(store, subscription);
  if (!icon) throw new SubscriptionError('not_found', 404);
  return c.body(icon.bytes, 200, { 'content-type': icon.contentType, 'x-content-type-options': 'nosniff' });
});
subscriptionRoutes.patch('/api/admin/subscriptions/:id', async c => {
  const body = object(await c.req.json()), store = new SubscriptionStore(getDB(c.env)), previous = await store.get(c.req.param('id'));
  checkRevision(previous, body);
  const next = structuredClone(previous);
  if (body.name !== undefined) next.name = text(body.name);
  for (const field of ['enabled', 'isPublic', 'autoSubscribe'] as const) if (body[field] !== undefined) {
    if (typeof body[field] !== 'boolean') throw new SubscriptionError('invalid_request'); next[field] = body[field];
  }
  if (body.archived !== undefined) { if (typeof body.archived !== 'boolean') throw new SubscriptionError('invalid_request'); next.archivedAt = body.archived ? now() : null; if (body.archived) next.enabled = false; }
  if (body.intervalSec !== undefined) next.intervalSec = integer(body.intervalSec, 60, 86400);
  if (body.staleAfterSec !== undefined) next.staleAfterSec = integer(body.staleAfterSec, 60, 604800);
  if (body.notifications !== undefined) {
    const supplied = object(body.notifications);
    next.notifications = { monitor: await policy(store, supplied.monitor), sync: { ...await policy(store, supplied.sync), afterSec: integer(object(supplied.sync).afterSec, 60, 86400) } };
  }
  next.revision = crypto.randomUUID(); next.updatedAt = now();
  if (previous.intervalSec !== next.intervalSec || previous.staleAfterSec !== next.staleAfterSec || previous.enabled !== next.enabled || previous.archivedAt !== next.archivedAt) { next.syncRevision = crypto.randomUUID(); next.runtime.nextDueAt = now(); }
  await store.update(previous, next);
  return c.json({ subscription: next });
});
subscriptionRoutes.delete('/api/admin/subscriptions/:id', async c => {
  const store = new SubscriptionStore(getDB(c.env)), previous = await store.get(c.req.param('id'));
  checkRevision(previous, object(await c.req.json())); await store.remove(previous); return c.json({ ok: true });
});
subscriptionRoutes.get('/api/admin/subscriptions/:id/items', async c => {
  const store = new SubscriptionStore(getDB(c.env)), subscription = await store.get(c.req.param('id'));
  let items = await store.itemIndex(subscription.id);
  items.sort((a, b) => a.sortOrder - b.sortOrder || (a.localName || a.name).localeCompare(b.localName || b.name) || a.id.localeCompare(b.id));
  const state = c.req.query('state');
  if (state === 'selected') items = items.filter(item => item.selected && item.removedAt === null);
  if (state === 'discovered') items = items.filter(item => !item.selected && item.removedAt === null);
  if (state === 'removed') items = items.filter(item => item.removedAt !== null);
  const query = c.req.query('q')?.toLowerCase(); if (query) items = items.filter(item => (item.localName ?? item.name).toLowerCase().includes(query));
  const result = page(items, c.req.query('offset'), c.req.query('limit'));
  return c.json({ ...result, items: (await store.itemsById(result.items.map(item => item.id))).map(item => subscriptionItemView(item, subscription, now())) });
});
subscriptionRoutes.patch('/api/admin/subscriptions/:id/items', async c => {
  const body = object(await c.req.json()), store = new SubscriptionStore(getDB(c.env)), subscription = await store.get(c.req.param('id'));
  if (!Array.isArray(body.items) || body.items.length > 100) throw new SubscriptionError('invalid_request');
  const results: { id: string; ok: boolean; error?: string; item?: SubscriptionItem }[] = [];
  for (const raw of body.items) {
    const update = object(raw), id = text(update.id, 64);
    try {
      const item = await store.item(id);
      if (item.subscriptionId !== subscription.id) throw new SubscriptionError('not_found', 404);
      if (item.revision !== update.revision) throw new SubscriptionError('revision_conflict', 409);
      for (const field of ['selected', 'isPublic', 'muted'] as const) if (update[field] !== undefined) {
        if (typeof update[field] !== 'boolean') throw new SubscriptionError('invalid_request');
        if (field === 'selected' && item.selected !== update[field]) item.baseline = false;
        item[field] = update[field];
      }
      if (update.localName !== undefined) item.localName = update.localName === null || update.localName === '' ? null : text(update.localName);
      if (update.groupId !== undefined) {
        const id = update.groupId === null ? null : text(update.groupId, 64);
        if (id && !await store.db.queryOne(store.sql('SELECT id FROM monitor_groups WHERE id=?'), [id])) throw new SubscriptionError('group_not_found');
        item.groupId = id;
      }
      if (update.sortOrder !== undefined) item.sortOrder = integer(update.sortOrder, 0, 100000);
      const persisted = await store.item(id);
      if (persisted.revision !== update.revision) throw new SubscriptionError('revision_conflict', 409);
      const next = { ...persisted, selected: item.selected, isPublic: item.isPublic, muted: item.muted, localName: item.localName, groupId: item.groupId, sortOrder: item.sortOrder, baseline: persisted.selected !== item.selected ? false : persisted.baseline, revision: crypto.randomUUID() };
      const write = store.write('UPDATE subscription_items SET json=?,revision=?,selected=?,is_public=? WHERE id=? AND revision=? AND json=?', [JSON.stringify(next), next.revision, Number(next.selected), Number(next.isPublic), id, persisted.revision, JSON.stringify(persisted)]);
      if ((await store.db.execute(write.sql, write.params)).rowsAffected !== 1) throw new SubscriptionError('revision_conflict', 409);
      results.push({ id, ok: true, item: next });
    } catch (error) { results.push({ id, ok: false, error: error instanceof SubscriptionError ? error.code : 'subscription_storage_unavailable' }); }
  }
  return c.json({ results });
});
subscriptionRoutes.post('/api/admin/subscriptions/:id/sync', async c => {
  const subscription = await new SubscriptionStore(getDB(c.env)).get(c.req.param('id'));
  const run = await runSubscription(c.env, subscription.id, true, undefined, undefined, work => c.executionCtx.waitUntil(work));
  return c.json({ runId: run.id, run }, 202);
});
subscriptionRoutes.get('/api/admin/subscriptions/:id/runs', async c => {
  const store = new SubscriptionStore(getDB(c.env)); await store.get(c.req.param('id'));
  return c.json({ runs: await Promise.all((await store.documents<SubscriptionRun>('run', c.req.param('id'))).map(run => subscriptionRunView(store, run))) });
});
subscriptionRoutes.get('/api/admin/subscription-runs/:runId', async c => {
  const store = new SubscriptionStore(getDB(c.env)), run = await store.document<SubscriptionRun>('run', c.req.param('runId'));
  if (!run) throw new SubscriptionError('not_found', 404); return c.json({ run: await subscriptionRunView(store, run) });
});
subscriptionRoutes.get('/api/admin/subscriptions/:id/items/:itemId/history', async c => {
  const item = await new SubscriptionStore(getDB(c.env)).item(c.req.param('itemId'));
  if (item.subscriptionId !== c.req.param('id')) throw new SubscriptionError('not_found', 404);
  return c.json({ days: item.days, recent: item.recent, availability: item.availability, mode: item.mode });
});

subscriptionRoutes.get('/api/admin/subscriptions/:id/config', async c => {
  const store = new SubscriptionStore(getDB(c.env)), subscription = await store.get(c.req.param('id'));
  const config = await store.document<StoredSubscriptionConfig>('config', subscription.configId);
  if (!config) throw new SubscriptionError('not_found', 404);
  return c.json({ config: configView(config), revision: subscription.revision });
});
subscriptionRoutes.get('/api/admin/subscriptions/:id/config/export', async c => {
  const store = new SubscriptionStore(getDB(c.env)), subscription = await store.get(c.req.param('id'));
  const config = await store.document<StoredSubscriptionConfig>('config', subscription.configId);
  if (!config) throw new SubscriptionError('not_found', 404);
  c.header('content-disposition', `attachment; filename="${config.descriptor.id}.json"`);
  return c.json(config.descriptor);
});
subscriptionRoutes.post('/api/admin/subscriptions/:id/config/check-update', async c => {
  const store = new SubscriptionStore(getDB(c.env)), subscription = await store.get(c.req.param('id'));
  const config = await store.document<StoredSubscriptionConfig>('config', subscription.configId);
  if (!config?.sourceUrl) throw new SubscriptionError('subscription_update_source_missing');
  const update = await checkSubscriptionUpdate(store, config, subscription.id, true);
  if (update.error) throw new SubscriptionError(update.error, 502);
  return c.json({ ...update, currentVersion: config.descriptor.version });
});
subscriptionRoutes.post('/api/admin/subscriptions/:id/config/preview', async c => {
  const body = object(await c.req.json()), store = new SubscriptionStore(getDB(c.env)), subscription = await store.get(c.req.param('id'));
  checkRevision(subscription, body);
  const config = await store.document<StoredSubscriptionConfig>('config', subscription.configId);
  if (!config) throw new SubscriptionError('not_found', 404);
  const candidate = body.rollback === true ? await store.document<StoredSubscriptionConfig>('previous-config', subscription.id) : null;
  if (body.rollback === true && !candidate) throw new SubscriptionError('not_found', 404);
  const descriptor = validateSubscriptionDescriptor(candidate?.descriptor ?? body.descriptor ?? config.descriptor);
  if (!descriptor.categories.includes(subscription.category)) throw new SubscriptionError('subscription_category_invalid');
  const secrets = await decryptSubscriptionSecrets(config.ciphertext, config.id, c.env.ADMIN_TOKEN);
  if (Object.keys(secrets).some(name => descriptor.inputs[name] && descriptor.inputs[name].type !== 'secret')) throw new SubscriptionError('subscription_secret_type_changed', 409);
  const inherited = Object.fromEntries(Object.entries({ ...(candidate?.parameters ?? config.parameters), ...secrets }).filter(([name]) => Object.hasOwn(descriptor.inputs, name)));
  const parameters = { ...inherited, ...object(body.parameters ?? {}) };
  const oldBindings = subscriptionCredentialBindings(config.descriptor, { ...config.parameters, ...secrets });
  const newBindings = subscriptionCredentialBindings(descriptor, parameters as Record<string, string | number | boolean>);
  if (Object.keys(secrets).some(name => descriptor.inputs[name] && JSON.stringify(oldBindings[name]) !== JSON.stringify(newBindings[name]) && !Object.hasOwn(object(body.parameters ?? {}), name))) throw new SubscriptionError('subscription_credentials_rebind_required', 409);
  const knownUpdate = await store.document<{ candidate?: SubscriptionDescriptor; sourceUrl?: string }>('config-update', config.id);
  const modified = JSON.stringify(descriptor) === JSON.stringify(knownUpdate?.candidate) ? false : JSON.stringify(descriptor) === JSON.stringify(config.descriptor) ? config.modified : true;
  const sourceUrl = body.rollback === true ? candidate?.sourceUrl : !modified ? knownUpdate?.sourceUrl ?? config.sourceUrl : config.sourceUrl;
  const preview = await createSubscriptionPreview(store, c.env, { descriptor, parameters, sourceUrl, origin: config.origin, subscriptionId: subscription.id, revision: subscription.revision, modified }, await owner(c), undefined, work => c.executionCtx.waitUntil(work));
  return c.json({ preview: previewView(preview), previewId: preview.id }, 202);
});
subscriptionRoutes.put('/api/admin/subscriptions/:id/config', async c => {
  const body = object(await c.req.json()), store = new SubscriptionStore(getDB(c.env)), subscription = await store.get(c.req.param('id'));
  checkRevision(subscription, body);
  const preview = await store.document<StoredSubscriptionPreview>('preview', text(body.previewId, 64));
  if (!preview || preview.owner !== await owner(c) || preview.state !== 'ready' || preview.subscriptionId !== subscription.id || preview.revision !== subscription.revision) throw new SubscriptionError('subscription_preview_expired', 409);
  const previous = await store.document<StoredSubscriptionConfig>('config', subscription.configId);
  const config = await previewConfig(preview, c.env, crypto.randomUUID());
  const next = { ...subscription, sourceUrl: config.sourceUrl, configId: config.id, syncRevision: crypto.randomUUID(), revision: crypto.randomUUID(), templateName: config.descriptor.name, templateVersion: config.descriptor.version, updatedAt: now(), runtime: { ...subscription.runtime, nextDueAt: now() } };
  next.sourceHosts = [...new Set(Object.values(config.descriptor.requests).map(request => new URL(String(config.parameters[request.baseUrlInput] ?? config.descriptor.inputs[request.baseUrlInput]?.default)).hostname))];
  next.sourcePageUrl = subscriptionSourcePage(config.descriptor, config.parameters);
  const writes = [];
  writes.push(store.write("DELETE FROM subscription_documents WHERE kind='config' AND subscription_id=?", [subscription.id]));
  writes.push(store.write("DELETE FROM subscription_documents WHERE kind IN ('response-part','config-update') AND subscription_id=?", [subscription.id]));
  if (previous && subscriptionIdentity(previous) !== subscriptionIdentity(config)) {
    if (body.confirmIdentityChange !== true) throw new SubscriptionError('subscription_identity_confirmation_required', 409);
    const items = await store.items(subscription.id);
    writes.push(...await store.identityWrites(items, remapSubscriptionIdentities(items, preview.items.map(item => item.sourceItemId), body.identityMappings ?? [], now()), subscription.id));
  }
  await store.update(subscription, next, [...writes, store.documentWrite('previous-config', subscription.id, previous, subscription.id), store.documentWrite('config', config.id, config, subscription.id), store.write("DELETE FROM subscription_documents WHERE kind IN ('response-cache','checkpoint') AND id=?", [subscription.id])]);
  return c.json({ subscription: next });
});

function publicItem(item: SubscriptionItem, subscription: Subscription) {
  const view = subscriptionItemView(item, subscription, now());
  return { id: view.id, category: view.category, name: view.localName || view.name, source: { id: subscription.id, name: subscription.name, url: subscription.sourcePageUrl ?? null },
    group: view.group, modelId: view.modelId, provider: view.provider, protocol: view.protocol, mode: view.mode, freshness: view.freshness, status: view.displayStatus,
    observation: view.observation, recent: view.recent, availability: view.availability };
}
async function publicAllowed(env: Env, request: Request, kind: SubscriptionCategory): Promise<boolean> {
  const context = await requestPage(env, request);
  return context.enabled && context.configured && (kind === 'website' ? context.kind === 'monitor' : context.config.aiEnabled && (context.kind === 'ai' || context.kind === 'monitor' && context.config.aiOnMonitorPage));
}
subscriptionRoutes.get('/api/public/subscriptions/items', async c => {
  c.header('cache-control', 'no-store');
  const kind = category(c.req.query('category'));
  if (!await publicAllowed(c.env, c.req.raw, kind)) throw new SubscriptionError('not_found', 404);
  const store = new SubscriptionStore(getDB(c.env)), subscriptions = new Map((await store.list()).filter(row => row.isPublic && row.archivedAt === null && row.category === kind).map(row => [row.id, row]));
  const items = (await store.itemIndex(undefined, true)).filter(item => item.removedAt === null && subscriptions.has(item.subscriptionId)).sort((a, b) => a.sortOrder - b.sortOrder || (a.localName || a.name).localeCompare(b.localName || b.name) || a.id.localeCompare(b.id));
  const result = page(items, c.req.query('offset'), c.req.query('limit'));
  return c.json({ ...result, items: (await store.itemsById(result.items.map(item => item.id))).filter(item => item.selected && item.isPublic && item.removedAt === null).map(item => publicItem(item, subscriptions.get(item.subscriptionId)!)) });
});
for (const history of [false, true]) subscriptionRoutes.get(`/api/public/subscriptions/items/:id${history ? '/history' : ''}`, async c => {
  c.header('cache-control', 'no-store');
  const store = new SubscriptionStore(getDB(c.env)), item = await store.item(c.req.param('id')!), subscription = await store.get(item.subscriptionId);
  if (!item.selected || !item.isPublic || item.removedAt !== null || !subscription.isPublic || subscription.archivedAt !== null || !await publicAllowed(c.env, c.req.raw, subscription.category)) throw new SubscriptionError('not_found', 404);
  return c.json(history ? { days: item.days, recent: item.recent, availability: item.availability, mode: item.mode } : { item: publicItem(item, subscription) });
});
