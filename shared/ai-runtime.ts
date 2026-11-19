import type { AiDayStat, AiHistoryPoint, AiModel, AiModelLive, AiRecentCheck, AiSkipReason } from './ai-management';

export interface AiRuntimeEntry extends AiHistoryPoint {
  recent: AiRecentCheck[];
  nextCheckAt: number;
  lastAttemptAt: number;
  skipReason: AiSkipReason;
  total: number;
  ok: number;
  consecutiveFailures: number;
  settled: 'up' | 'down';
  announced: 'up' | 'down';
  alertPending: boolean;
  day: { date: string; total: number; ok: number; latencyTotalMs: number } | null;
}
export interface AiRuntimeState {
  models: Record<string, AiRuntimeEntry>;
  channels: Record<string, { revision: string; nextAllowedAt: number }>;
}
export const emptyAiRuntime = (): AiRuntimeState => ({ models: {}, channels: {} });
export const aiPercent = (ok: number, total: number): number | null => total ? ok * 100 / total : null;
export const aiNextCheckAt = (now: number, delay: number): number => Math.min(Number.MAX_SAFE_INTEGER, now + delay);
export function aiDay(day: NonNullable<AiRuntimeEntry['day']>): AiDayStat {
  return { date: day.date, total: day.total, ok: day.ok, availabilityPct: aiPercent(day.ok, day.total), avgLatencyMs: day.total ? day.latencyTotalMs / day.total : null, exact: true };
}
export function aiEntry(model: Pick<AiModel, 'revision'>, channelRevision: string, previous?: AiRuntimeEntry): AiRuntimeEntry {
  if (previous?.revision === model.revision && previous.channelRevision === channelRevision) return { ...previous, recent: [...(previous.recent ?? [])], day: previous.day && { ...previous.day } };
  return { checkedAt: 0, outcome: 'invalid_config', latencyMs: 0, statusCode: 0, revision: model.revision, channelRevision, runId: '',
    nextCheckAt: 0, lastAttemptAt: 0, skipReason: null, total: previous?.total ?? 0, ok: previous?.ok ?? 0, consecutiveFailures: 0,
    settled: 'up', announced: 'up', alertPending: false, recent: [], day: previous?.day ? { ...previous.day } : null };
}
export function aiLive(model: Pick<AiModel, 'revision' | 'enabled' | 'intervalSec'>, channelRevision: string, previous: AiRuntimeEntry | undefined, now: number, available = true): AiModelLive {
  const entry = aiEntry(model, channelRevision, previous), changed = Boolean(previous && (previous.revision !== model.revision || previous.channelRevision !== channelRevision));
  return { checkedAt: entry.checkedAt || null, outcome: entry.checkedAt ? entry.outcome : null, latencyMs: entry.checkedAt ? entry.latencyMs : null,
    statusCode: entry.statusCode, revision: model.revision, channelRevision, runId: entry.runId || null, nextCheckAt: entry.nextCheckAt,
    lastAttemptAt: entry.lastAttemptAt || null, skipReason: available ? entry.skipReason : 'runtime_unavailable',
    freshness: !model.enabled ? 'paused' : changed ? 'configuration_changed' : !entry.checkedAt ? 'never_checked' : now > entry.checkedAt + model.intervalSec * 2 ? 'stale' : 'current',
    total: entry.total, ok: entry.ok, availabilityPct: aiPercent(entry.ok, entry.total), consecutiveFailures: entry.consecutiveFailures };
}
export function recordAiObservation(entry: AiRuntimeEntry, point: AiHistoryPoint, intervalSec: number, failuresRequired: number): AiDayStat | null {
  if (entry.runId === point.runId || entry.checkedAt > point.checkedAt) return null;
  const date = new Date(point.checkedAt * 1000).toISOString().slice(0, 10);
  const closed = entry.day && entry.day.date !== date ? aiDay(entry.day) : null;
  if (!entry.day || entry.day.date !== date) entry.day = { date, total: 0, ok: 0, latencyTotalMs: 0 };
  Object.assign(entry, point, { lastAttemptAt: point.checkedAt, nextCheckAt: point.checkedAt + intervalSec, skipReason: null });
  entry.recent = [...(entry.recent ?? []), { checkedAt: point.checkedAt, outcome: point.outcome, latencyMs: point.latencyMs, statusCode: point.statusCode }].slice(-60);
  entry.total++; entry.day.total++; entry.day.latencyTotalMs += point.latencyMs;
  if (point.outcome === 'ok') { entry.ok++; entry.day.ok++; entry.consecutiveFailures = 0; entry.settled = 'up'; }
  else { entry.consecutiveFailures++; if (entry.consecutiveFailures >= Math.max(1, failuresRequired)) entry.settled = 'down'; }
  entry.alertPending = entry.settled !== entry.announced;
  return closed;
}
export function aiBackoff(outcome: AiHistoryPoint['outcome'], interval: number, retryAfterSec = 0): number {
  if (['authentication_failed', 'permission_denied', 'quota_exhausted'].includes(outcome)) return Math.max(interval, 3600);
  if (['rate_limited', 'rate_limit_or_quota'].includes(outcome)) return Math.max(interval, retryAfterSec || 900);
  return 0;
}
