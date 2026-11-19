import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import type { AiManualResult } from '../../../../../shared/ai-management';
import type { Env } from '../../types';
import { loadPresentation } from '../presentation/store';
import { getDB } from '../db/factory';
import { safeEqual } from '../auth/service';
import { decryptAiCredential, decryptAiHeaders } from './credentials';
import { fetchAiModels, probeAiChannel, probeAiModel } from './probe';
import { AiStore, aiStorageError, channelView } from './store';
import { AiError, aiObject, aiRevision, channelInput, modelInput } from './validation';
import { aiHistory, aiHistoryDays, publicAiModel } from './history';

export const aiRoutes = new Hono<{ Bindings: Env }>();
aiRoutes.use('/api/admin/ai/*', bodyLimit({ maxSize: 262144, onError: c => c.json({ error: 'invalid_request' }, 400) }));
aiRoutes.use('/api/admin/ai/*', async (c, next) => {
  c.header('cache-control', 'private, no-store');
  if (c.req.method !== 'GET' && c.req.method !== 'HEAD') {
    const bearer = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const origin = c.req.header('origin');
    if (!(c.env.ADMIN_TOKEN && safeEqual(bearer, c.env.ADMIN_TOKEN)) &&
        (origin ? origin !== new URL(c.req.url).origin : c.req.header('sec-fetch-site') === 'cross-site')) return c.json({ error: 'invalid_origin' }, 403);
  }
  await next();
});
aiRoutes.onError((error, c) => {
  const safe = aiStorageError(error, c.req.path.includes('/models'));
  return c.json({ error: safe.code }, safe.status);
});

async function read(request: { json(): Promise<unknown> }): Promise<Record<string, unknown>> {
  try { return aiObject(await request.json()); } catch { throw new AiError('invalid_request'); }
}

aiRoutes.get('/api/admin/ai/channels', async c => c.json({ channels: await new AiStore(getDB(c.env)).channels() }));
aiRoutes.get('/api/admin/ai/channels/:id', async c => {
  const channel = await new AiStore(getDB(c.env)).channel(c.req.param('id'));
  const headers = await decryptAiHeaders(channel.headers_ciphertext, channel.id, c.env.ADMIN_TOKEN);
  return c.json({ channel: { ...channelView(channel), headers } });
});
aiRoutes.get('/api/admin/ai/channels/:id/models', async c => {
  const store = new AiStore(getDB(c.env)), channel = await store.channel(c.req.param('id'));
  const apiKey = await decryptAiCredential(channel.credential_ciphertext, channel.id, c.env.ADMIN_TOKEN);
  const headers = await decryptAiHeaders(channel.headers_ciphertext, channel.id, c.env.ADMIN_TOKEN);
  const result = await fetchAiModels({ protocol: channel.protocol, baseUrl: channel.base_url, apiKey, headers, timeoutMs: 15000 });
  if ((await store.channel(channel.id)).revision !== channel.revision) throw new AiError('revision_conflict', 409);
  if (result.outcome !== 'ok') return c.json({ error: 'ai_models_unavailable', outcome: result.outcome }, 502);
  return c.json({ models: result.models, fetchedAt: Math.floor(Date.now()/1000) });
});
aiRoutes.get('/api/admin/ai/models', async c => c.json({ models: await new AiStore(getDB(c.env)).models() }));
aiRoutes.get('/api/admin/ai/models/:id', async c => c.json({ model: await new AiStore(getDB(c.env)).model(c.req.param('id')) }));
aiRoutes.get('/api/admin/ai/models/:id/history', async c => {
  const model = await new AiStore(getDB(c.env)).model(c.req.param('id'));
  return c.json(await aiHistory(c.env, model.id, aiHistoryDays(c.req.query('days'))));
});
aiRoutes.get('/api/public/ai/models', async c => {
  c.header('cache-control','private, no-store');
  try { return c.json({ models: (await new AiStore(getDB(c.env)).models()).filter(model => model.enabled && model.isPublic).map(publicAiModel) }); }
  catch (error) { if ((error as { code?: string })?.code === '42P01' || /no such table: ai_/i.test(String(error))) return c.json({ models: [] }); throw error; }
});
for (const history of [false,true]) aiRoutes.get(`/api/public/ai/models/:id${history ? '/history' : ''}`, async c => {
  c.header('cache-control','private, no-store');
  const model = await new AiStore(getDB(c.env)).model(c.req.param('id')!);
  if (!model.enabled || !model.isPublic) throw new AiError('not_found',404);
  return history ? c.json(await aiHistory(c.env,model.id,aiHistoryDays(c.req.query('days')))) : c.json({ model: publicAiModel(model) });
});

aiRoutes.post('/api/admin/ai/channels', async c => {
  const input = channelInput(await read(c.req), true);
  return c.json({ channel: await new AiStore(getDB(c.env)).saveChannel(input, c.env.ADMIN_TOKEN) }, 201);
});
aiRoutes.put('/api/admin/ai/channels/:id', async c => {
  const body = await read(c.req), input = channelInput(body, false), revision = aiRevision(body.revision);
  return c.json({ channel: await new AiStore(getDB(c.env)).saveChannel(input, c.env.ADMIN_TOKEN, c.req.param('id'), revision) });
});
aiRoutes.post('/api/admin/ai/models', async c => c.json({ model: await new AiStore(getDB(c.env)).saveModel(modelInput(await read(c.req), true)) }, 201));
aiRoutes.put('/api/admin/ai/models/:id', async c => {
  const body = await read(c.req), input = modelInput(body, false), revision = aiRevision(body.revision);
  return c.json({ model: await new AiStore(getDB(c.env)).saveModel(input, c.req.param('id'), revision) });
});
for (const kind of ['channels', 'models'] as const) {
  aiRoutes.delete(`/api/admin/ai/${kind}/:id`, async c => {
    const revision = aiRevision((await read(c.req)).revision);
    await new AiStore(getDB(c.env)).remove(kind, c.req.param('id')!, revision);
    return c.json({ ok: true });
  });
}

aiRoutes.post('/api/admin/ai/channels/:id/test', async c => {
  if (!(await loadPresentation(c.env)).config.aiEnabled) throw new AiError('ai_disabled', 409);
  const revision = aiRevision((await read(c.req)).revision), store = new AiStore(getDB(c.env));
  const channel = await store.channel(c.req.param('id'));
  if (channel.revision !== revision) throw new AiError('revision_conflict', 409);
  const apiKey = await decryptAiCredential(channel.credential_ciphertext, channel.id, c.env.ADMIN_TOKEN);
  const result = await probeAiChannel({ protocol: channel.protocol, baseUrl: channel.base_url, headers: await decryptAiHeaders(channel.headers_ciphertext, channel.id, c.env.ADMIN_TOKEN), apiKey, timeoutMs: 10000 });
  if ((await store.channel(channel.id)).revision !== revision) throw new AiError('revision_conflict', 409);
  return c.json({ result: { ...result, kind: 'channel', checkedAt: Math.floor(Date.now() / 1000), revision, channelRevision: revision } satisfies AiManualResult });
});
aiRoutes.post('/api/admin/ai/models/:id/check', async c => {
  if (!(await loadPresentation(c.env)).config.aiEnabled) throw new AiError('ai_disabled', 409);
  const body = await read(c.req);
  if (body.confirmPaid !== true) throw new AiError('paid_confirmation_required');
  const revision = aiRevision(body.revision), channelRevision = aiRevision(body.channelRevision), store = new AiStore(getDB(c.env));
  const model = await store.model(c.req.param('id')), channel = await store.channel(model.channelId);
  if (model.revision !== revision || channel.revision !== channelRevision) throw new AiError('revision_conflict', 409);
  const apiKey = await decryptAiCredential(channel.credential_ciphertext, channel.id, c.env.ADMIN_TOKEN);
  const result = await probeAiModel({ protocol: channel.protocol, baseUrl: channel.base_url, headers: await decryptAiHeaders(channel.headers_ciphertext, channel.id, c.env.ADMIN_TOKEN), apiKey, model: model.modelId, request: model.request, timeoutMs: model.timeoutMs });
  if ((await store.model(model.id)).revision !== revision || (await store.channel(channel.id)).revision !== channelRevision) throw new AiError('revision_conflict', 409);
  return c.json({ result: { outcome: result.outcome, statusCode: result.statusCode, latencyMs: result.latencyMs, kind: 'model', checkedAt: Math.floor(Date.now() / 1000), revision, channelRevision } satisfies AiManualResult });
});
