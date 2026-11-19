import type { CheckQueueErrorCode, CheckQueueMessage, CheckQueueStatus, CheckQueueTask } from '../../../../../shared/check-queue';
import type { DBAdapter } from '../db/adapter';
import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { parseQueueMessage } from './messages';

export interface QueueControl {
  enabled: boolean;
  generation: string;
  verification: { id: string; startedAt: number; expiresAt: number; processedAt: number | null; failed: boolean } | null;
  pending: Record<string, { message: Extract<CheckQueueMessage, { type: 'checks' }>; sentAt: number | null }>;
  lastEnqueuedAt: number | null;
  lastProcessedAt: number | null;
  lastError: { code: CheckQueueErrorCode; at: number } | null;
}

export const INITIAL_QUEUE_JSON = '{"enabled":false,"generation":"initial","verification":null,"pending":{},"lastEnqueuedAt":null,"lastProcessedAt":null,"lastError":null}';
export class QueueError extends Error {
  constructor(readonly code: CheckQueueErrorCode, readonly status: 400 | 409 | 503 = 503) { super(code); }
}
export interface QueueSnapshot { state: QueueControl; revision: string }
export function queueSql(db: Pick<DBAdapter, 'type'>, query: string): string {
  let n = 0;
  return db.type === 'postgres' ? query.replace(/\?/g, () => `$${++n}`) : query;
}

export async function loadQueue(env: Env): Promise<QueueSnapshot> {
  try {
    const row = await getDB(env).queryOne<{ json: string; revision: string }>('SELECT json,revision FROM check_queue_control WHERE id=1');
    if (!row) throw new QueueError('schema_required');
    const state = JSON.parse(row.json) as QueueControl;
    if (typeof state.enabled !== 'boolean' || typeof state.generation !== 'string' || !state.pending ||
        typeof state.pending !== 'object' || Array.isArray(state.pending)) throw new QueueError('storage_unavailable');
    for (const [id, batch] of Object.entries(state.pending)) {
      if (!batch || !parseQueueMessage(batch.message) || batch.message.type !== 'checks' || batch.message.id !== id ||
          (batch.sentAt !== null && !Number.isSafeInteger(batch.sentAt))) throw new QueueError('storage_unavailable');
    }
    return { state, revision: row.revision };
  } catch (error) {
    if (error instanceof QueueError) throw error;
    if ((error as { code?: string }).code === '42P01' || /no such table: check_queue_control/.test(String(error))) {
      throw new QueueError('schema_required');
    }
    throw new QueueError('storage_unavailable');
  }
}

export function queueWrite(env: Env, snapshot: QueueSnapshot) {
  return {
    sql: queueSql(getDB(env), 'UPDATE check_queue_control SET json=CASE WHEN revision=? THEN ? ELSE NULL END,revision=? WHERE id=1'),
    params: [snapshot.revision, JSON.stringify(snapshot.state), crypto.randomUUID()],
  };
}

export function publicQueueStatus(env: Env, snapshot?: QueueSnapshot, error?: QueueError): CheckQueueStatus {
  const now = Math.floor(Date.now() / 1000), state = snapshot?.state, probe = state?.verification;
  const tasks = Object.values(state?.pending ?? {}).flatMap(batch => batch.message.tasks);
  const verified = probe?.processedAt && !probe.failed && now >= probe.processedAt && now - probe.processedAt <= 600;
  let lastError = state?.lastError ?? null;
  if (probe && !probe.failed && !probe.processedAt && now >= probe.expiresAt) lastError = { code: 'probe_timeout', at: probe.expiresAt };
  if (state?.enabled && !env.CHECK_QUEUE) lastError = { code: 'binding_missing', at: now };
  if (error) lastError = { code: error.code, at: now };
  return {
    supported: true,
    bound: Boolean(env.CHECK_QUEUE),
    enabled: state?.enabled ?? false,
    canEnable: Boolean(env.CHECK_QUEUE && !error && verified),
    schema: error?.code === 'schema_required' ? 'missing' : error ? 'unavailable' : 'ready',
    revision: snapshot?.revision ?? null,
    verification: {
      state: !probe ? 'never' : probe.failed ? 'failed' : probe.processedAt ? 'passed' : now >= probe.expiresAt ? 'timed_out' : 'pending',
      startedAt: probe?.startedAt ?? null,
      expiresAt: probe?.expiresAt ?? null,
      processedAt: probe?.processedAt ?? null,
    },
    lastEnqueuedAt: state?.lastEnqueuedAt ?? null,
    lastProcessedAt: state?.lastProcessedAt ?? null,
    oldestPendingAt: tasks.length ? Math.min(...tasks.map(task => task.scheduledAt)) : null,
    pendingTasks: tasks.length,
    lastError,
    limits: {
      tasksPerMessage: 10, pendingTasks: 1000,
      externalRequestsPerInvocation: 50, aePointsPerInvocation: 250,
      recommendedBatchSize: 1, recommendedConcurrency: 1,
    },
  };
}

export async function queueRouting(env: Env): Promise<boolean> {
  try { return (await loadQueue(env)).state.enabled; }
  catch (error) {
    if (error instanceof QueueError && error.code === 'schema_required') return false;
    throw error;
  }
}
export const taskKey = (task: Pick<CheckQueueTask, 'kind' | 'id'>) => `${task.kind}:${task.id}`;
