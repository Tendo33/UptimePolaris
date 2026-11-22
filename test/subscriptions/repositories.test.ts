import assert from 'node:assert/strict';
import { Miniflare } from 'miniflare';
import { api } from '../../backends/worker/src/api';
import { bootstrapSchema } from '../../backends/worker/src/lib/db/bootstrap';
import { withDBScope } from '../../backends/worker/src/lib/db/factory';
import { JSON_SUBSCRIPTION } from '../../shared/subscription-templates';
import { parseSubscriptionCatalog, subscriptionRepositoryUrl } from '../../shared/subscription-catalog';
import type { Env } from '../../backends/worker/src/types';

const entry = { id: JSON_SUBSCRIPTION.id, name: JSON_SUBSCRIPTION.name, description: '', categories: ['website'], kind: 'template', version: '1.0.0', path: 'templates/json-website/1.0.0.json', capabilities: JSON_SUBSCRIPTION.capabilities, limitations: [] };
for (const path of ['../secret.json', 'https://elsewhere.net/a.json', 'templates/a/2.0.0.json', 'templates/a/%2e%2e/a.json']) {
  assert.throws(() => parseSubscriptionCatalog({ schemaVersion: 1, entries: [{ ...entry, path }] }));
}
assert.throws(() => parseSubscriptionCatalog({ schemaVersion: 1, entries: [entry, entry] }));
for (const url of ['http://status.service.net/catalog.json', 'https://127.0.0.1/catalog.json', 'https://status.service.net/catalog.json?token=x', 'https://user:pass@status.service.net/catalog.json']) assert.throws(() => subscriptionRepositoryUrl(url));
assert.equal(subscriptionRepositoryUrl('https://github.com/owner/repo/blob/main/catalog.json'), 'https://raw.githubusercontent.com/owner/repo/main/catalog.json');

const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("ok")}}', compatibilityDate: '2025-01-01', d1Databases: ['DB'], kvNamespaces: ['CONFIG'] });
const original = globalThis.fetch;
let offline = false;
try {
  const env = { DB: await mf.getD1Database('DB'), CONFIG: await mf.getKVNamespace('CONFIG'), UPTIME: { writeDataPoint() {} }, DATABASE_TYPE: 'd1', ADMIN_TOKEN: 'repository-fixture-admin-material', PBKDF2_ITERATIONS: '3000', AUTOMATIC_NOTIFICATIONS_DISABLED: 'true' } as unknown as Env;
  await bootstrapSchema(env);
  globalThis.fetch = async input => {
    const url = new URL(String(input));
    if (url.hostname === 'cloudflare-dns.com') return Response.json({ Status: 0, Answer: [{ type: 1, data: '1.1.1.1' }] });
    if (url.hostname === 'raw.githubusercontent.com') return Response.json({ schemaVersion: 1, entries: [entry] });
    assert.equal(url.hostname, 'status.service.net');
    if (offline) return new Response('', { status: 503 });
    if (url.pathname.endsWith('catalog.json')) return Response.json({ schemaVersion: 1, entries: [entry] });
    if (url.pathname.endsWith('1.0.0.json')) return Response.json(JSON_SUBSCRIPTION);
    return Response.json({ services: [{ id: 'portal', name: 'Portal', status: 'up' }] });
  };
  await withDBScope(env, async scoped => {
    const req = async (method: string, path: string, body?: unknown, auth = true): Promise<any> => {
      const tasks: Promise<unknown>[] = [];
      const response = await api.fetch(new Request('https://fixture.test' + path, { method, headers: { 'content-type': 'application/json', ...(auth ? { authorization: `Bearer ${env.ADMIN_TOKEN}` } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), scoped, { waitUntil(task: Promise<unknown>) { tasks.push(task); } } as ExecutionContext);
      const result = await response.json(); await Promise.all(tasks);
      if (response.status >= 500) console.log(method, path, response.status, result);
      return { status: response.status, body: result };
    };
    assert.equal((await req('POST', '/api/auth/setup', { credential: env.ADMIN_TOKEN, username: 'repository-owner', password: 'repository-fixture-password' }, false)).status, 200);
    assert.equal((await req('POST', '/api/admin/subscription-repositories', { name: 'Private', url: 'https://status.service.net/a/catalog.json' }, false)).status, 401);
    const add = async (folder: string) => req('POST', '/api/admin/subscription-repositories', { name: folder, url: `https://status.service.net/${folder}/catalog.json` });
    const a = await add('a'), b = await add('b');
    assert.equal(a.status, 201, JSON.stringify(a)); assert.equal(b.status, 201);
    assert.equal((await add('a')).status, 409);
    const list = await req('GET', '/api/admin/subscription-catalog');
    const external = list.body.entries.filter((item: any) => item.origin === 'third-party');
    assert.equal(external.length, 2); assert.notEqual(external[0].id, external[1].id);
    assert.equal(list.body.repositories.length, 2);
    const template = await req('GET', '/api/admin/subscription-catalog/' + encodeURIComponent(external[0].id));
    assert.equal(template.body.descriptor.id, JSON_SUBSCRIPTION.id);
    const preview = await req('POST', '/api/admin/subscription-configs/preview', { templateId: external[0].id, parameters: { baseUrl: 'https://status.service.net' } });
    assert.equal(preview.status, 202, JSON.stringify(preview));
    const ready = await req('GET', '/api/admin/subscription-previews/' + preview.body.previewId);
    assert.equal(ready.body.preview.state, 'ready', JSON.stringify(ready));
    const created = await req('POST', '/api/admin/subscriptions', { requestId: 'repository-create', previewId: preview.body.previewId, category: 'website', name: 'Imported', selectedIds: ['portal'], isPublic: false });
    assert.equal(created.status, 201, JSON.stringify(created));
    offline = true;
    await req('POST', '/api/admin/subscription-catalog/refresh');
    const cached = await req('GET', '/api/admin/subscription-catalog');
    assert.equal(cached.body.entries.filter((item: any) => item.origin === 'third-party').length, 2);
    assert.ok(cached.body.repositories.every((row: any) => row.stale && row.error === 'subscription_catalog_unavailable'));
    await req('DELETE', '/api/admin/subscription-repositories/' + a.body.repository.id);
    assert.equal((await req('GET', '/api/admin/subscriptions/' + created.body.subscription.id + '/config')).status, 200);
    assert.equal((await req('GET', '/api/admin/subscription-catalog/' + encodeURIComponent(external.find((item: any) => item.repositoryId === a.body.repository.id).id))).status, 404);
  });
  console.log('PASS repository URL and catalog validation, namespace isolation, preview/create, cached failure and removal preservation');
} finally { globalThis.fetch = original; await mf.dispose(); }
