import { Hono } from 'hono';
import type { Env } from '../../types';
import { safeEqual } from '../auth/service';
import { getDB } from '../db/factory';
import { withWriterLease } from '../jobs/writer-lease';
import { commitTickWrites } from '../jobs/tick-commit';
import { loadQueue, publicQueueStatus, QueueError, queueWrite } from './control';
export const checkQueueRoutes = new Hono<{
  Bindings: Env;
}>();
checkQueueRoutes.use('/api/admin/check-queue*', async (c, next) => {
  c.header('cache-control', 'private, no-store');
  if (c.req.method !== 'GET') {
    const token = c.req.header('authorization')?.replace(/^Bearer\s+/i, '') ?? '', origin = c.req.header('origin');
    if (!(c.env.ADMIN_TOKEN && safeEqual(token, c.env.ADMIN_TOKEN)) && (origin ? origin !== new URL(c.req.url).origin : c.req.header('sec-fetch-site') === 'cross-site'))
      return c.json({ error: 'invalid_origin' }, 403);
  }
  await next();
});
checkQueueRoutes.onError((error, c) => { const safe = error instanceof QueueError ? error : new QueueError('storage_unavailable'); return c.json({ error: safe.code }, safe.status); });
checkQueueRoutes.get('/api/admin/check-queue', async (c) => {
  try {
    return c.json(publicQueueStatus(c.env, await loadQueue(c.env)));
  }
  catch (error) {
    return c.json(publicQueueStatus(c.env, undefined, error instanceof QueueError ? error : new QueueError('storage_unavailable')));
  }
});
for (const probe of [false, true])
  checkQueueRoutes.on(probe ? 'POST' : 'PUT', `/api/admin/check-queue${probe ? '/probe' : ''}`, async (c) => {
    let body: Record<string, unknown>;
    try {
      body = await c.req.json();
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.revision !== 'string' || body.revision.length > 64 || !probe && typeof body.enabled !== 'boolean')
        throw new Error();
    }
    catch {
      throw new QueueError('invalid_request', 400);
    }
    await loadQueue(c.env);
    const result = await withWriterLease(c.env, async (owner) => {
      let snapshot = await loadQueue(c.env);
      if (snapshot.revision !== body.revision)
        throw new QueueError('revision_conflict', 409);
      const now = Math.floor(Date.now() / 1000);
      if (probe) {
        if (!c.env.CHECK_QUEUE)
          throw new QueueError('binding_missing');
        if (snapshot.state.verification && !snapshot.state.verification.processedAt && !snapshot.state.verification.failed && snapshot.state.verification.expiresAt > now)
          throw new QueueError('probe_pending', 409);
        const id = crypto.randomUUID();
        snapshot.state.verification = { id, startedAt: now, expiresAt: now + 120, processedAt: null, failed: false };
        snapshot.state.lastError = null;
        await commitTickWrites(getDB(c.env), owner, now, [queueWrite(c.env, snapshot)]);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([c.env.CHECK_QUEUE.send({ type: 'probe', id, generation: snapshot.state.generation, createdAt: now, expiresAt: now + 120 }), new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('enqueue_timeout')), 10000); })]);
        }
        catch {
          snapshot = await loadQueue(c.env);
          snapshot.state.verification!.failed = true;
          snapshot.state.lastError = { code: 'enqueue_failed', at: now };
          await commitTickWrites(getDB(c.env), owner, Math.floor(Date.now() / 1000), [queueWrite(c.env, snapshot)]);
          throw new QueueError('enqueue_failed');
        }
        finally {
          if (timer)
            clearTimeout(timer);
        }
      }
      else {
        if (body.enabled && !snapshot.state.enabled) {
          if (!c.env.CHECK_QUEUE)
            throw new QueueError('binding_missing');
          if (!publicQueueStatus(c.env, snapshot).canEnable)
            throw new QueueError('probe_required', 409);
        }
        if (snapshot.state.enabled !== body.enabled) {
          snapshot.state.enabled = body.enabled as boolean;
          snapshot.state.generation = crypto.randomUUID();
          snapshot.state.pending = {};
          snapshot.state.lastError = null;
          await commitTickWrites(getDB(c.env), owner, now, [queueWrite(c.env, snapshot)]);
        }
      }
      return publicQueueStatus(c.env, await loadQueue(c.env));
    });
    if (!result.acquired)
      throw new QueueError('writer_busy', 409);
    return c.json(result.value, probe ? 202 : 200);
  });
