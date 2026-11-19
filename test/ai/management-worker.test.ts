import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { api } from '../../backends/worker/src/api';
import { bootstrapSchema } from '../../backends/worker/src/lib/db/bootstrap';
import { BOOTSTRAP_FILES } from '../../backends/worker/src/lib/db/schema-bootstrap';
import { encryptAiCredential, decryptAiCredential } from '../../backends/worker/src/lib/ai/credentials';
import { aiBaseUrl } from '../../backends/worker/src/lib/ai/validation';
import { loadPresentation, savePresentation } from '../../backends/worker/src/lib/presentation/store';
import { D1Adapter } from '../../backends/worker/src/lib/db/d1';
import { AiStore } from '../../backends/worker/src/lib/ai/store';
import { getDB } from '../../backends/worker/src/lib/db/factory';
import { runTick } from '../../backends/worker/src/lib/jobs/tick';
import { verifyProtocolUpgrade } from './protocol-upgrade';
import { aiOptionsScenario } from './options-worker.test';
import type { Env } from '../../backends/worker/src/types';

export async function workerApiScenario(env: Env, inspect: (id: string) => Promise<string>) {
  let cookie = '', calls = 0, nextStatus = 200, nextBody: unknown = { choices: [{ message: { content: 'OK' } }] };
  let expectedKey = 'fixture-api-key-first';
  let mutateInFlight: (() => Promise<void>) | undefined;
  const original = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    calls++;
    assert.equal(new URL(String(input)).origin, 'https://provider.example');
    assert.equal(init?.redirect, 'manual');
    assert.equal(new Headers(init?.headers).get('authorization'), `Bearer ${expectedKey}`);
    const url = String(input);
    if (init?.method === 'GET') assert.equal(url, 'https://provider.example/custom%2Ftenant/v1/models');
    else {
      assert.equal(url, 'https://provider.example/custom%2Ftenant/v1/chat/completions');
      assert.equal(JSON.parse(String(init?.body)).model, 'fixture-model');
    }
    if (mutateInFlight) { const mutation = mutateInFlight; mutateInFlight = undefined; await mutation(); }
    return Response.json(nextBody, { status: nextStatus, headers: nextStatus === 302 ? { location: 'https://attacker.example' } : {} });
  };
  const request = async (method: string, path: string, body?: unknown, auth: 'bearer' | 'cookie' | 'none' = 'bearer', override = env, extraHeaders: Record<string, string> = {}) => {
    const headers = new Headers({ 'content-type': 'application/json', ...extraHeaders });
    if (auth === 'bearer') headers.set('authorization', `Bearer ${override.ADMIN_TOKEN}`);
    if (auth === 'cookie') headers.set('cookie', cookie);
    const response = await api.fetch(new Request(`https://fixture.test${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) }), override, { waitUntil() {} } as ExecutionContext);
    const raw = await response.text();
    assert.doesNotMatch(raw, /fixture-api-key|credential_ciphertext|"apiKey"/);
    assert.match(response.headers.get('cache-control') ?? '', /no-store/);
    return { status: response.status, body: JSON.parse(raw), response };
  };
  const expect = async (method: string, path: string, body: unknown, status: number, error?: string, auth?: 'bearer' | 'cookie' | 'none', override?: Env, headers?: Record<string, string>) => {
    const result = await request(method, path, body, auth, override, headers);
    assert.equal(result.status, status, JSON.stringify(result.body));
    if (error) assert.equal(result.body.error, error);
    return result;
  };
  try {
    const setup = await request('POST', '/api/auth/setup', { credential: env.ADMIN_TOKEN, username: 'ai-owner', password: 'fixture-owner-password' }, 'none');
    assert.equal(setup.status, 200, JSON.stringify(setup.body));
    const presentation = await loadPresentation(env);
    await savePresentation(env, { ...presentation.config, aiEnabled: true }, presentation.revision);
    cookie = setup.response.headers.get('set-cookie')!.split(';')[0];
    for (const path of ['/api/admin/ai/channels', '/api/admin/ai/models']) {
      for (const method of ['GET', 'POST', 'PUT', 'DELETE']) await expect(method, path + (method === 'PUT' || method === 'DELETE' ? '/missing' : ''), method === 'GET' ? undefined : {}, 401, 'unauthorized', 'none');
    }
    assert.deepEqual((await expect('GET', '/api/admin/ai/channels', undefined, 200)).body, { channels: [] });
    const input = { name: 'Fixture channel', baseUrl: 'https://provider.example/custom%2Ftenant/v1/', protocol: 'openai', apiKey: expectedKey };
    await expect('POST', '/api/admin/ai/channels', { ...input, apiKey: undefined }, 400, 'api_key_required');
    await expect('POST', '/api/admin/ai/channels', { ...input, baseUrl: 'https://169.254.169.254/v1' }, 400, 'invalid_ai_url');
    if (env.DATABASE_TYPE === 'd1') await expect('POST', '/api/admin/ai/channels', input, 503, 'ai_key_material_unavailable', 'cookie', { ...env, ADMIN_TOKEN: '' });
    let channel = (await expect('POST', '/api/admin/ai/channels', input, 201)).body.channel;
    assert.equal(channel.hasApiKey, true); assert.equal(channel.baseUrl, input.baseUrl);
    const channelPath = `/api/admin/ai/channels/${channel.id}`;
    const stored = await inspect(channel.id);
    assert.match(stored, /^v1\./); assert.ok(!stored.includes(expectedKey));
    assert.equal(await decryptAiCredential(stored, channel.id, env.ADMIN_TOKEN), expectedKey);
    await assert.rejects(() => decryptAiCredential(stored, 'other-id', env.ADMIN_TOKEN), /ai_credential_decryption_failed/);
    await expect('POST', '/api/admin/ai/channels', input, 409, 'duplicate_channel_name');
    const read = (await expect('GET', channelPath, undefined, 200, undefined, 'cookie')).body.channel;
    assert.deepEqual(Object.keys(read).sort(), ['id', 'name', 'baseUrl', 'protocol', 'hasApiKey', 'headerNames', 'headers', 'notificationChannelIds', 'notificationEnabled', 'revision', 'createdAt', 'updatedAt'].sort());
    const keep = { ...input, apiKey: undefined, revision: channel.revision };
    await expect('PUT', channelPath, keep, 403, 'invalid_origin', 'cookie', env, { origin: 'https://attacker.example' });
    const versions = await Promise.all([request('PUT', channelPath, keep), request('PUT', channelPath, keep)]);
    assert.deepEqual(versions.map(r => r.status).sort(), [200, 409]);
    channel = versions.find(r => r.status === 200)!.body.channel;
    assert.equal(await inspect(channel.id), stored);
    await expect('DELETE', channelPath, { revision: keep.revision }, 409, 'revision_conflict');
    if (env.DATABASE_TYPE === 'd1') {
      const rotated = { ...env, ADMIN_TOKEN: 'rotated-material' };
      await expect('POST', `${channelPath}/test`, { revision: channel.revision }, 503, 'ai_credential_decryption_failed', 'cookie', rotated);
      channel = (await expect('PUT', channelPath, { ...input, revision: channel.revision }, 200, undefined, 'cookie', rotated)).body.channel;
      assert.equal(await decryptAiCredential(await inspect(channel.id), channel.id, rotated.ADMIN_TOKEN), expectedKey);
      await expect('POST', `${channelPath}/test`, { revision: channel.revision }, 503, 'ai_credential_decryption_failed');
    }
    assert.equal(calls, 0);
    const replaced = { ...input, apiKey: 'fixture-api-key-second', revision: channel.revision };
    channel = (await expect('PUT', channelPath, replaced, 200)).body.channel;
    expectedKey = replaced.apiKey;
    assert.notEqual(await inspect(channel.id), stored);
    await expect('POST', '/api/admin/ai/models', { channelId: 'missing', name: 'Model', modelId: 'fixture-model' }, 404, 'not_found');
    let model = (await expect('POST', '/api/admin/ai/models', { channelId: channel.id, name: 'Model', modelId: 'fixture-model' }, 201)).body.model;
    assert.equal(model.intervalSec, 300); assert.equal(model.timeoutMs, 30000); assert.equal(model.enabled, true); assert.equal(model.isPublic, false);
    const modelPath = `/api/admin/ai/models/${model.id}`;
    await expect('POST', '/api/admin/ai/models', { channelId: channel.id, name: 'Other', modelId: model.modelId }, 409, 'duplicate_model');
    await expect('POST', '/api/admin/ai/models', { channelId: channel.id, name: model.name, modelId: 'other' }, 409, 'duplicate_model');
    await expect('PUT', modelPath, { ...model, enabled: 0 }, 400, 'invalid_request');
    const updates = await Promise.all([request('PUT', modelPath, { ...model, enabled: false }), request('PUT', modelPath, { ...model, isPublic: true })]);
    assert.deepEqual(updates.map(r => r.status).sort(), [200, 409]);
    model = updates.find(r => r.status === 200)!.body.model;
    await expect('POST', `${modelPath}/check`, { revision: model.revision, channelRevision: channel.revision }, 400, 'paid_confirmation_required');
    assert.equal(calls, 0);
    nextBody = { data: [] };
    let checked = (await expect('POST', `${channelPath}/test`, { revision: channel.revision }, 200)).body.result;
    assert.equal(checked.kind, 'channel'); assert.equal(checked.outcome, 'ok');
    nextStatus = 404; nextBody = { error: { message: expectedKey } };
    checked = (await expect('POST', `${channelPath}/test`, { revision: channel.revision }, 200)).body.result;
    assert.equal(checked.outcome, 'models_endpoint_unsupported');
    for (const [status, body, outcome] of [[200, { choices: [{ message: { content: 'OK' } }] }, 'ok'], [401, { error: { message: expectedKey } }, 'authentication_failed'], [429, { error: { code: 'insufficient_quota', message: expectedKey } }, 'quota_exhausted'], [302, {}, 'unexpected_status']] as const) {
      nextStatus = status; nextBody = body;
      checked = (await expect('POST', `${modelPath}/check`, { revision: model.revision, channelRevision: channel.revision, confirmPaid: true }, 200)).body.result;
      assert.equal(checked.kind, 'model'); assert.equal(checked.outcome, outcome); assert.equal(checked.revision, model.revision);
      assert.ok(checked.checkedAt > 0);
    }
    assert.equal(calls, 6);
    const before = calls;
    await expect('POST', `${modelPath}/check`, { revision: 'stale', channelRevision: channel.revision, confirmPaid: true }, 409, 'revision_conflict');
    assert.equal(calls, before);
    mutateInFlight = async () => { model = (await expect('PUT', modelPath, { ...model, name: 'Changed while checking' }, 200)).body.model; };
    await expect('POST', `${modelPath}/check`, { revision: model.revision, channelRevision: channel.revision, confirmPaid: true }, 409, 'revision_conflict');
    const listed = (await expect('GET', modelPath, undefined, 200)).body.model;
    assert.deepEqual(Object.keys(listed).sort(), ['id', 'channelId', 'channelName', 'name', 'modelId', 'intervalSec', 'timeoutMs', 'enabled', 'isPublic', 'revision', 'createdAt', 'updatedAt', 'live', 'request', 'recent'].sort());
    await expect('DELETE', modelPath, { revision: model.revision }, 200);
    await expect('GET', modelPath, undefined, 404, 'not_found');
    await expect('POST', '/api/admin/ai/models', { channelId: channel.id, name: 'Cascade', modelId: 'cascade-model' }, 201);
    await expect('DELETE', channelPath, { revision: channel.revision }, 200);
    assert.deepEqual((await expect('GET', '/api/admin/ai/models', undefined, 200)).body, { models: [] });
    assert.equal((await request('GET', '/api/monitors')).status, 200);
    const protocols = JSON.parse(readFileSync('test/fixtures/ai-protocols.json', 'utf8'));
    for (const [index, fixture] of protocols.entries()) {
      globalThis.fetch = async (url, init) => {
        assert.equal(String(url), `https://provider.example/v1/${init?.method === 'GET' ? 'models' : fixture.path}`);
        for (const [header, value] of Object.entries(fixture.headers)) assert.equal(new Headers(init?.headers).get(header), String(value).replace('fixture-secret', expectedKey));
        if (init?.method !== 'GET') assert.deepEqual(JSON.parse(String(init?.body)), fixture.body);
        return Response.json(init?.method === 'GET' ? fixture.models : fixture.response);
      };
      let native = (await expect('POST', '/api/admin/ai/channels', { ...input, name: fixture.protocol, baseUrl: 'https://provider.example/v1', apiKey: expectedKey, protocol: fixture.protocol }, 201)).body.channel;
      const nativePath = `/api/admin/ai/channels/${native.id}`;
      native = (await expect('PUT', nativePath, { ...native, name: `${fixture.protocol} edited` }, 200)).body.channel;
      assert.equal(native.protocol, fixture.protocol);
      const nativeModel = (await expect('POST', '/api/admin/ai/models', { channelId: native.id, name: 'Native', modelId: 'fixture-model' }, 201)).body.model;
      if (fixture.protocol === 'gemini') await expect('POST', '/api/admin/ai/models', { channelId: native.id, name: 'Invalid path', modelId: 'models/fixture-model' }, 400, 'invalid_ai_model_id');
      assert.equal((await expect('POST', `${nativePath}/test`, { revision: native.revision }, 200)).body.result.outcome, 'ok');
      assert.equal((await expect('POST', `/api/admin/ai/models/${nativeModel.id}/check`, { revision: nativeModel.revision, channelRevision: native.revision, confirmPaid: true }, 200)).body.result.outcome, 'ok');
      assert.equal((await runTick(env, Math.floor(Date.now()/60000)*60 + index*60)).status, 'completed');
      const live = (await new AiStore(getDB(env)).model(nativeModel.id)).live;
      assert.equal(live.outcome, 'ok', fixture.protocol);
      assert.equal(live.total, 1);
      await expect('DELETE', nativePath, { revision: native.revision }, 200);
    }
    await expect('POST', '/api/admin/ai/channels', { ...input, protocol: 'unsupported' }, 400, 'invalid_request');
    await aiOptionsScenario(env);
  } finally { globalThis.fetch = original; }
}

export async function runD1() {
  for (const fixture of JSON.parse(readFileSync('test/fixtures/ai-url-policy.json', 'utf8'))) {
    if (fixture.valid) assert.doesNotThrow(() => aiBaseUrl(fixture.url), fixture.url);
    else assert.throws(() => aiBaseUrl(fixture.url), /invalid_ai_url/, fixture.url);
  }
  const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2025-01-01', d1Databases: { DB: crypto.randomUUID() }, kvNamespaces: { CONFIG: crypto.randomUUID() } });
  try {
    const db = await mf.getD1Database('DB');
    const env = { DB: db, CONFIG: await mf.getKVNamespace('CONFIG'), ADMIN_TOKEN: 'fixture-ai-installation-key', PBKDF2_ITERATIONS: '3000', DATABASE_TYPE: 'd1', UPTIME: { writeDataPoint() {} } } as Env;
    const plan = BOOTSTRAP_FILES;
    await db.exec('CREATE TABLE d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)');
    for (const file of plan.filter(file => file.name < '0045')) await db.batch([db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(file.name), ...file.statements.map((s: string) => db.prepare(s))]);
    await db.prepare("INSERT INTO monitor_groups(id,name,created_at,updated_at) VALUES('ai-upgrade-fixture','Retained',1,1)").run();
    const missing = await api.fetch(new Request('https://fixture.test/api/admin/ai/channels', { headers: { authorization: `Bearer ${env.ADMIN_TOKEN}` } }), env, { waitUntil() {} } as ExecutionContext);
    assert.equal(missing.status, 503); assert.equal((await missing.json() as { error: string }).error, 'ai_schema_required');
    for (const file of plan.filter(file => file.name >= '0045' && file.name < '0048')) await db.batch([db.prepare('INSERT INTO d1_migrations(name) VALUES(?)').bind(file.name), ...file.statements.map((s: string) => db.prepare(s))]);
    await verifyProtocolUpgrade(new D1Adapter(db), () => bootstrapSchema(env).then(() => {}));
    assert.ok(await db.prepare("SELECT id FROM monitor_groups WHERE id='ai-upgrade-fixture'").first());
    await workerApiScenario(env, async id => (await db.prepare('SELECT credential_ciphertext FROM ai_channels WHERE id=?').bind(id).first<{ credential_ciphertext: string }>())!.credential_ciphertext);
    const cipher = await encryptAiCredential('fixture-rotation', 'channel-id', env.ADMIN_TOKEN);
    assert.equal(await decryptAiCredential(cipher, 'channel-id', env.ADMIN_TOKEN), 'fixture-rotation');
    console.log('PASS AI Worker D1 API: upgrade, auth, CRUD, encryption, CAS, cascade, manual checks and redaction');
  } finally { await mf.dispose(); }
}

if (process.env.AI_TEST_DRIVER !== 'postgres') await runD1();
