import assert from 'node:assert/strict';
import { api } from '../../backends/worker/src/api';
import type { Env } from '../../backends/worker/src/types';
import { AiStore } from '../../backends/worker/src/lib/ai/store';
import { getDB } from '../../backends/worker/src/lib/db/factory';
import { decryptAiHeaders } from '../../backends/worker/src/lib/ai/credentials';
import { runTick } from '../../backends/worker/src/lib/jobs/tick';
import { loadPresentation, savePresentation } from '../../backends/worker/src/lib/presentation/store';

export async function aiOptionsScenario(env: Env) {
  const original = globalThis.fetch;
  const feature = await loadPresentation(env), store = new AiStore(getDB(env));
  let calls = 0;
  const request = async (method: string, path: string, input?: unknown, host = 'fixture.test') => {
    const response = await api.fetch(new Request(`https://${host}${path}`, { method, headers: { 'content-type': 'application/json', authorization: `Bearer ${env.ADMIN_TOKEN}` }, body: input === undefined ? undefined : JSON.stringify(input) }), env, { waitUntil() {} } as ExecutionContext);
    const raw = await response.text();
    assert.doesNotMatch(raw, /private-header-fixture|headers_ciphertext|credential_ciphertext/);
    return { status: response.status, data: JSON.parse(raw) };
  };
  const expect = async (method: string, path: string, input: unknown, status = 200, host?: string) => { const result = await request(method, path, input, host); assert.equal(result.status, status, JSON.stringify(result.data)); return result.data; };
  try {
    const input = { name: 'Custom options', baseUrl: 'https://provider.example/v1', protocol: 'openai', apiKey: 'options-fixture-key', headers: { 'CF-Access-Client-Secret': 'private-header-fixture' } };
    let channel = (await expect('POST', '/api/admin/ai/channels', input, 201)).channel;
    const path = `/api/admin/ai/channels/${channel.id}`;
    const stored = await store.channel(channel.id);
    assert.ok(!stored.headers_ciphertext.includes('private-header-fixture'));
    assert.deepEqual(await decryptAiHeaders(stored.headers_ciphertext, channel.id, env.ADMIN_TOKEN), { 'cf-access-client-secret': 'private-header-fixture' });
    assert.deepEqual(channel.headerNames, ['cf-access-client-secret']);
    channel = (await expect('PUT', path, { name: channel.name, baseUrl: channel.baseUrl, protocol: channel.protocol, revision: channel.revision })).channel;
    assert.equal((await store.channel(channel.id)).headers_ciphertext, stored.headers_ciphertext);
    let model = (await expect('POST', '/api/admin/ai/models', { channelId: channel.id, name: 'Custom model', modelId: 'fixture', enabled: true, isPublic: true, request: { prompt: 'Return READY.', maxOutputTokens: 128, expectedText: 'READY' } }, 201)).model;
    const modelPath = `/api/admin/ai/models/${model.id}`;
    globalThis.fetch = async (_url, init) => {
      calls++;
      assert.equal(new Headers(init?.headers).get('cf-access-client-secret'), 'private-header-fixture');
      const body = JSON.parse(String(init?.body)); assert.equal(body.max_tokens, 128); assert.equal(body.messages[0].content, 'Return READY.');
      return Response.json({ choices: [{ message: { content: 'READY' } }] });
    };
    const check = () => expect('POST', `${modelPath}/check`, { revision: model.revision, channelRevision: channel.revision, confirmPaid: true });
    assert.equal((await check()).result.outcome, 'ok');
    model = (await expect('PUT', modelPath, { ...model, request: { ...model.request, expectedText: 'DIFFERENT' } })).model;
    const { request: ignored, ...withoutRequest } = model;
    model = (await expect('PUT', modelPath, { ...withoutRequest, name: 'Preserved options' })).model;
    assert.equal(model.request.expectedText, 'DIFFERENT');
    assert.equal((await check()).result.outcome, 'response_mismatch');
    const now = Math.floor(Date.now() / 60000) * 60 + 600;
    await runTick(env, now);
    assert.equal((await store.model(model.id)).live.outcome, 'response_mismatch');
    let state = await loadPresentation(env);
    await savePresentation(env, { ...state.config, aiEnabled: true, aiOnMonitorPage: false, domains: [{ hostname: 'fixture.test', page: 'monitor' }, { hostname: 'ai.fixture.test', page: 'ai' }], pages: { ...state.config.pages, ai: { theme: null, themeOptions: { title: 'Models', description: 'Fixture page', layout: 'cards', showLatency: false } } } }, state.revision);
    assert.equal((await request('GET', '/api/public/ai/models')).status, 404);
    const independent = await request('GET', '/api/public/ai/models', undefined, 'ai.fixture.test');
    assert.equal(independent.status, 200); assert.equal(independent.data.models.length, 1);
    assert.doesNotMatch(JSON.stringify(independent.data), /prompt|maxOutputTokens|expectedText|headers|baseUrl/);
    const config = (await request('GET', '/api/public/config', undefined, 'ai.fixture.test')).data;
    assert.equal(config.presentation.kind, 'ai'); assert.equal(config.presentation.showLatency, false); assert.equal(config.config.title, 'Models');
    assert.equal((await request('GET', '/api/public/config?view=ai')).data.presentation.kind, 'ai');
    state = await loadPresentation(env);
    await savePresentation(env, { ...state.config, aiOnMonitorPage: true }, state.revision);
    assert.equal((await request('GET', '/api/public/ai/models')).status, 200);
    state = await loadPresentation(env);
    await savePresentation(env, { ...state.config, aiEnabled: false }, state.revision);
    const before = calls;
    assert.equal((await request('POST', `${modelPath}/check`, { revision: model.revision, channelRevision: channel.revision, confirmPaid: true })).data.error, 'ai_disabled');
    await runTick(env, now + 3600); assert.equal(calls, before);
    assert.equal((await request('GET', '/api/public/ai/models', undefined, 'ai.fixture.test')).status, 404);
    assert.ok(await store.model(model.id));
    channel = (await expect('PUT', path, { name: channel.name, baseUrl: channel.baseUrl, protocol: channel.protocol, revision: channel.revision, headers: {} })).channel;
    assert.deepEqual(channel.headerNames, []); assert.equal((await store.channel(channel.id)).headers_ciphertext, '');
    await expect('DELETE', path, { revision: channel.revision });
    console.log(`PASS AI ${getDB(env).type} options: protected headers, request matching, feature shutdown and independent/main-page scope`);
  } finally {
    globalThis.fetch = original;
    const current = await loadPresentation(env);
    await savePresentation(env, feature.config, current.revision);
  }
}
