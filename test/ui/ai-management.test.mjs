import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const esbuild = require('../../frontend/node_modules/esbuild');
const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
const components = new Proxy({}, { get: (_, key) => key });
const text = node => typeof node === 'string' || typeof node === 'number' ? String(node) : (node?.props?.children ?? []).flat(Infinity).map(text).join('');
const all = (node, predicate) => !node || typeof node !== 'object' ? [] : [...(predicate(node) ? [node] : []), ...(node.props?.children ?? []).flat(Infinity).flatMap(child => all(child, predicate))];
const find = (tree, predicate) => all(tree, predicate)[0];
const byName = (tree, name) => find(tree, node => node.props.name === name);
const button = (tree, label) => find(tree, node => node.type === 'Button' && text(node) === label);
const tick = () => new Promise(resolve => setImmediate(resolve));
class ApiError extends Error { constructor(code, status = 400) { super(code); this.code = code; this.status = status; } }

function load(file, modules) {
  const code = esbuild.transformSync(readFileSync(file.startsWith('frontend/') ? file : `frontend/src/admin/ai/${file}`, 'utf8'), { loader: file.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', jsx: 'transform' }).code;
  const module = { exports: {} };
  Function('require', 'module', 'exports', 'React', code)(id => modules[id] ?? components, module, module.exports, React);
  return module.exports;
}
function harness(file, name, props, api, extra = {}) {
  let cursor = 0;
  const slots = [];
  const effects = [];
  const status = load('frontend/src/components/ai/status.ts', {});
  const presentation = load('presentation.ts', { '@/components/ai/status': status });
  const request = load('frontend/../shared/ai-request.ts', {});
  const Component = load(file, {
    react: { useState: initial => { const i = cursor++; if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial; return [slots[i], value => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; }]; }, useRef: initial => { const i = cursor++; return slots[i] ??= { current: initial }; }, useId: () => `fixture-${cursor++}`, useMemo: fn => fn(), useEffect: (fn, deps) => { const i=cursor++; if (!slots[i] || deps?.some((value,index)=>value!==slots[i][index])) { slots[i]=deps; effects.push(fn); } } },
    'use-intl': { useTranslations: ns => Object.assign(key => `${ns}.${key}`, { has: () => true }), useFormatter: () => ({ dateTime: () => 'fixture time', number: value => String(value) }) },
    '@/api/errors': { ApiError, isRetryableApiError: () => false },
    '../../../../shared/ai-request': request,
    '../settings/presentation-api': { usePresentation:()=>({data:{config:{aiEnabled:true,aiOnMonitorPage:true}}}) },
    '../../../../shared/ai-probe': { AI_PROTOCOLS: ['openai', 'openai_responses', 'anthropic', 'gemini'] },
    './api': { aiApi: { channel:async()=>({channel:{...channel,headers:{}}}),...api }, useAiData:()=>extra.swr?.(), useRemoteModels:()=>({}) }, './useAiError': { useAiError: () => error => error.code },
    './presentation': presentation,
    '@/components/ui/toast': { toast: { success() {} } },
    clsx: (...values) => values.filter(Boolean).join(' '),
    ...extra,
  })[name];
  return () => { cursor = 0; const tree=Component(props); for(const effect of effects.splice(0)) effect(); return tree; };
}
const channel = { id: 'channel', name: 'Channel', baseUrl: 'https://api.example.com/v1', protocol: 'openai', hasApiKey: true, revision: 'c1' };
const model = { id: 'model', channelId: channel.id, name: 'Model', modelId: 'example-model', intervalSec: 300, timeoutMs: 30000, enabled: true, isPublic: false, revision: 'm1' };
const live = { checkedAt: 100, outcome: 'ok', freshness: 'current', skipReason: null, latencyMs: 20, total: 2, ok: 1, availabilityPct: 50 };

test('editing preserves the encrypted key unless replacement is selected; failures keep the draft', async () => {
  const writes = [], saved = [];
  let fail = true;
  const render = harness('AiEditors.tsx', 'ChannelEditor', { channel, onClose() {}, onSaved: value => saved.push(value) }, {
    updateChannel: async (id, value) => { writes.push({ id, value }); if (fail) throw new ApiError('ai_storage_unavailable', 503); return { channel: { ...channel, ...value, revision: 'c2' } }; },
  });
  assert.equal(byName(render(), 'apiKey'), undefined);
  byName(render(), 'name').props.onValueChange('Edited');
  await find(render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(Object.hasOwn(writes[0].value, 'apiKey'), false);
  assert.equal(byName(render(), 'name').props.value, 'Edited');
  assert.equal(saved.length, 0);
  fail = false;
  await find(render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(saved[0].revision, 'c2');
  find(render(), node => node.type === 'Switch').props.onValueChange(true);
  byName(render(), 'apiKey').props.onValueChange('fixture-replacement');
  await find(render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(writes[2].value.apiKey, 'fixture-replacement');
  assert.equal(byName(render(), 'apiKey').props.value, '');
});

test('model checks require explicit paid confirmation and allow retry after a failed request', async () => {
  let checks = 0, fail = true;
  const resource = { data: { channels: [channel], models: [model] }, mutate: async () => {}, error: null, isValidating: false };
  const render = harness('AiPage.tsx', 'AiPage', {}, {
    list() {}, checkModel: async () => { checks++; if (fail) throw new ApiError('ai_storage_unavailable', 503); return { result: { kind: 'model', outcome: 'ok', revision: 'm1', channelRevision: 'c1', checkedAt: 1, statusCode: 200, latencyMs: 10 } }; },
  }, {
    swr: () => resource,
    'react-router': { useNavigate: () => () => {}, useParams: () => ({ channelId: channel.id }), useSearchParams:()=>[new URLSearchParams(),()=>{}], Link: 'Link' },
    '../useConsoleData': { useConsoleRefreshInterval: () => 60000 },
  });
  find(render(), node => node.type === 'AiModelList').props.onCheck(model);
  assert.equal(checks, 0);
  button(render(), 'admin.ai.confirmPaid').props.onPress();
  await tick();
  assert.equal(checks, 1);
  assert.ok(button(render(), 'admin.ai.confirmPaid'), 'confirmation remains open after failure');
  fail = false;
  button(render(), 'admin.ai.confirmPaid').props.onPress();
  await tick();
  assert.equal(checks, 2);
  assert.equal(button(render(), 'admin.ai.confirmPaid'), undefined);
});

test('channel protocol selection is saved and reloaded without replacing the key or URL', async () => {
  const writes = [];
  const render = harness('AiEditors.tsx', 'ChannelEditor', { channel, onClose() {}, onSaved() {} }, {
    updateChannel: async (_, input) => { writes.push(input); throw new ApiError('revision_conflict', 409); },
    channel: async () => ({ channel: { ...channel, protocol: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', revision: 'c2' } }),
  });
  const select = () => find(render(),node=>typeof node.type==='function' && node.type.name==='ProtocolPicker');
  assert.equal(select().props.value, 'openai');
  select().props.onChange('anthropic');
  assert.equal(byName(render(), 'baseUrl').props.placeholder, 'https://api.anthropic.com/v1');
  assert.equal(byName(render(), 'baseUrl').props.value, channel.baseUrl);
  await find(render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(writes[0].protocol, 'anthropic');
  assert.equal(Object.hasOwn(writes[0], 'apiKey'), false);
  find(render(), node => typeof node.type === 'function' && node.type.name === 'FormError').props.reload();
  await tick();
  assert.equal(select().props.value, 'gemini');
  assert.equal(byName(render(), 'baseUrl').props.value, 'https://generativelanguage.googleapis.com/v1beta');
});

test('Gemini model forms constrain resource paths without limiting other protocols', () => {
  for (const protocol of ['openai', 'openai_responses', 'anthropic', 'gemini']) {
    const render = harness('AiEditors.tsx', 'ModelEditor', { channel: { ...channel, protocol }, model: null, onClose() {}, onSaved() {} }, {}, { swr: () => ({ data: { channels: [] } }) });
    const field = byName(render(), 'modelId');
    assert.equal(field.props.description, `admin.ai.${protocol === 'gemini' ? 'geminiModelIdHint' : 'modelIdHint'}`);
    assert.equal(Boolean(field.props.pattern), protocol === 'gemini');
  }
});

test('custom headers are replaced explicitly; request options are included in model writes', async () => {
  const writes = [];
  const render = harness('AiEditors.tsx', 'ChannelEditor', { channel: { ...channel, headerNames: ['x-client'] }, onClose() {}, onSaved() {} }, {
    updateChannel: async (_, input) => { writes.push(input); return { channel: { ...channel, ...input } }; },
  });
  render(); await tick();
  find(render(),node=>node.type==='HeadersEditor').props.onChange('{"X-Client":"private-fixture"}',true);
  await find(render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.equal(writes[0].headers['x-client'], 'private-fixture');
  assert.equal(Object.hasOwn(writes[0], 'apiKey'), false);
  const modelWrites = [];
  const renderModel = harness('AiEditors.tsx', 'ModelEditor', { channel, model, onClose() {}, onSaved() {} }, { updateModel: async (_, input) => { modelWrites.push(input); return { model: { ...model, ...input } }; } }, { swr: () => ({ data: { channels: [] } }) });
  byName(renderModel(), 'prompt').props.onValueChange('Return READY.');
  byName(renderModel(), 'maxOutputTokens').props.onValueChange('256');
  byName(renderModel(), 'expectedText').props.onValueChange('READY');
  await find(renderModel(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(modelWrites[0].request, { prompt: 'Return READY.', maxOutputTokens: 256, expectedText: 'READY' });
});

test('a failed AI feature update leaves confirmed settings and the cache unchanged', async () => {
  let state = { config: { aiEnabled: false, aiOnMonitorPage: true }, revision:'p1' }, cache=state;
  let fail = true;
  const {updatePresentation}=load('frontend/src/admin/settings/presentation-api.ts', {
    '@/api/errors':{ApiError}, '@/api/client':{requestJson:async(_,init)=>{if(!init)return state;if(fail)throw new ApiError('storage_unavailable',503);state=JSON.parse(init.body);return state;}},
    swr:{mutate:async(_,next)=>{cache=next;}},
  });
  await assert.rejects(updatePresentation(config=>({...config,aiEnabled:true})),{code:'storage_unavailable'});
  assert.equal(state.config.aiEnabled,false); assert.equal(cache.config.aiEnabled,false);
  fail = false;
  await updatePresentation(config=>({...config,aiEnabled:true})); assert.equal(state.config.aiEnabled,true);assert.equal(cache.config.aiEnabled,true);
});

test('the API sends revisions, explicit payment confirmation and encoded IDs', async () => {
  const calls = [];
  const { aiApi } = load('api.ts', { '@/api/client': { requestJson: async (path, init) => { calls.push({ path, ...init }); return {}; } } });
  await aiApi.updateChannel('channel/id', { name: 'Channel', baseUrl: channel.baseUrl, protocol: 'openai', revision: 'c1' });
  assert.equal(calls[0].path, '/api/admin/ai/channels/channel%2Fid');
  assert.equal(Object.hasOwn(JSON.parse(calls[0].body), 'apiKey'), false);
  await aiApi.checkModel(model, channel);
  assert.deepEqual(JSON.parse(calls[1].body), { revision: 'm1', channelRevision: 'c1', confirmPaid: true });
  await aiApi.remove('channels', channel.id, channel.revision);
  assert.equal(calls[2].method, 'DELETE');
  assert.deepEqual(JSON.parse(calls[2].body), { revision: 'c1' });
});

test('skipped, stale and changed checks never appear as successful or failed checks', () => {
  const { aiStatusKey } = load('frontend/src/components/ai/status.ts', {});
  assert.equal(aiStatusKey(live), 'up');
  assert.equal(aiStatusKey({ ...live, outcome: 'authentication_failed' }), 'down');
  for (const freshness of ['paused', 'never_checked', 'stale', 'configuration_changed']) assert.equal(aiStatusKey({ ...live, freshness }), 'unknown');
  for (const skipReason of ['budget_exhausted', 'credential_unavailable', 'channel_backoff', 'runtime_unavailable']) assert.equal(aiStatusKey({ ...live, skipReason }), 'unknown');
});

test('public model search and filters use scheduled model state', () => {
  const { aiStatusKey } = load('frontend/src/components/ai/status.ts', {});
  const { filterAiModels } = load('frontend/src/components/status-page/AiModels.tsx', { '@/components/ai/status': { aiStatusKey } });
  const rows = [{ id: 'one', name: 'Primary Chat', live }, { id: 'two', name: 'Backup Chat', live: { ...live, outcome: 'timeout' } }, { id: 'three', name: 'Delayed Chat', live: { ...live, skipReason: 'budget_exhausted' } }].map(row=>({...row,channel:{id:'c',name:'Provider'}}));
  assert.deepEqual(filterAiModels(rows, ' primary ', 'up').map(row => row.id), ['one']);
  assert.deepEqual(filterAiModels(rows, 'chat', 'down').map(row => row.id), ['two']);
  assert.equal(filterAiModels(rows, '', 'all').length, 3);
  assert.equal(filterAiModels(rows, '', 'up', true).length, 0);
});

test('editing a channel preserves its existing notification selection', async () => {
  const writes = [];
  const render = harness('AiEditors.tsx', 'ChannelEditor', { channel: { ...channel, notificationChannelIds: ['alerts'] }, onClose() {}, onSaved() {} }, {
    updateChannel: async (_, input) => { writes.push(input); return { channel: { ...channel, ...input } }; },
  });
  await find(render(), node => node.type === 'form').props.onSubmit({ preventDefault() {} });
  assert.deepEqual(writes[0].notificationChannelIds, ['alerts']);
  assert.equal(writes[0].revision, channel.revision);
});

test('history keeps exact day counts separate from sampled details and hides revoked data', () => {
  const resource = { data: { days: [{ date: '2026-11-18', ok: 3, total: 4, availabilityPct: 75, avgLatencyMs: 20 }], points: [{checkedAt:1794956400,outcome:'ok',latencyMs:20,statusCode:200}], sampled: true, detailStatus: 'ready' }, error: null };
  const render = harness('frontend/src/components/ai/AiHistory.tsx', 'AiHistory', { url: () => '/fixture' }, {}, { swr: () => resource });
  assert.ok(text(render()).includes('3 / 4'));
  assert.ok(text(render()).includes('ai.sampled'));
  resource.error = new ApiError('not_found', 404);
  assert.equal(text(render()).includes('3 / 4'), false);
  assert.ok(text(render()).includes('ai.historyHidden'));
});

const queueStatus = { supported: true, bound: true, enabled: false, canEnable: false, schema: 'ready', revision: 'q1', verification: { state: 'never', startedAt: null, expiresAt: null, processedAt: null }, pendingTasks: 0, oldestPendingAt: null, lastEnqueuedAt: null, lastProcessedAt: null, lastError: null, limits: { tasksPerMessage: 10 } };

test('Go never mounts the Worker Queue controls or requests their API', () => {
  const render = harness('frontend/src/admin/settings/CheckQueuePanel.tsx', 'CheckQueuePanel', {}, {}, {
    '@/api/backend': { useBackendCapabilities: () => ({ data: { runtime: 'go' } }) },
    swr: () => { throw new Error('Queue status must not be requested on Go'); },
  });
  assert.equal(render(), null);
});

test('a probe acceptance is not verification; failed enablement preserves confirmed state', async () => {
  const writes = [];
  const resource = { data: structuredClone(queueStatus), error: null, mutate: async value => { if (value) resource.data = value; } };
  let fail = true;
  const api = {
    status() {},
    probe: async input => { writes.push(['probe', input]); return { ...resource.data, revision: 'q2', verification: { ...resource.data.verification, state: 'pending', expiresAt: Math.floor(Date.now() / 1000) + 120 } }; },
    update: async input => { writes.push(['update', input]); if (fail) throw new ApiError('storage_unavailable', 503); return { ...resource.data, enabled: input.enabled, revision: 'q4' }; },
  };
  const render = harness('frontend/src/admin/settings/CheckQueuePanel.tsx', 'WorkerCheckQueue', {}, {}, {
    './check-queue-api': { checkQueueApi: api }, swr: () => resource,
    '@/api/useApiErrorMessage': { useApiErrorMessage: () => error => error.code },
  });
  const toggle = () => find(render(), node => node.type === 'Switch');
  assert.equal(toggle().props.isDisabled, true);
  button(render(), 'admin.checkQueue.probe').props.onPress();
  await tick();
  assert.equal(resource.data.verification.state, 'pending');
  assert.equal(toggle().props.isDisabled, true);
  assert.deepEqual(writes, [['probe', { revision: 'q1' }]]);
  resource.data = { ...resource.data, revision: 'q3', verification: { ...resource.data.verification, state: 'passed', processedAt: 1 } };
  assert.equal(toggle().props.isDisabled, true, 'expired verification cannot enable batching');
  resource.data.canEnable = true;
  assert.equal(toggle().props.isDisabled, false);
  toggle().props.onValueChange(true);
  await tick();
  assert.equal(toggle().props.isSelected, false);
  assert.ok(text(render()).includes('admin.checkQueue.errors.storage_unavailable'));
  fail = false;
  toggle().props.onValueChange(true);
  await tick();
  assert.equal(toggle().props.isSelected, true);
  assert.deepEqual(writes[2], ['update', { revision: 'q3', enabled: true }]);
  resource.error = new ApiError('unauthorized', 401);
  assert.equal(toggle(), undefined);
});

test('Queue API sends only current revision and explicit enablement', async () => {
  const writes = [];
  const { checkQueueApi } = load('frontend/src/admin/settings/check-queue-api.ts', { '@/api/client': { requestJson: async (path, init) => { writes.push({ path, ...init }); return {}; } } });
  await checkQueueApi.probe({ revision: 'q1' });
  assert.equal(writes[0].path, '/api/admin/check-queue/probe');
  assert.deepEqual(JSON.parse(writes[0].body), { revision: 'q1' });
  await checkQueueApi.update({ revision: 'q2', enabled: false });
  assert.equal(writes[1].method, 'PUT');
  assert.deepEqual(JSON.parse(writes[1].body), { revision: 'q2', enabled: false });
});
