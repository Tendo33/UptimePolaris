import type { AiDayStat, AiHistoryPoint, AiModelHistory, PublicAiModel } from '../../../../../shared/ai-management';
import { aiDay } from '../../../../../shared/ai-runtime';
import type { Env } from '../../types';
import { analyticsDataset, analyticsReadable, queryAnalytics } from '../analytics-engine';
import { getDB } from '../db/factory';
import { AiStore } from './store';
import { AiError } from './validation';

export function aiHistoryDays(value: string | undefined): number {
  if (value === undefined) return 7;
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 90) throw new AiError('invalid_request');
  return Number(value);
}
export async function aiHistory(env: Env, id: string, days: number): Promise<AiModelHistory> {
  const db = getDB(env), store = new AiStore(db), now = Math.floor(Date.now()/1000), since = Math.floor(now/86400)*86400-(days-1)*86400;
  const stored = await store.runtime();
  const row = await db.queryOne<{ days_json: string }>(store.sql('SELECT days_json FROM ai_daily WHERE model_id=?'), [id]);
  const map = new Map<string,AiDayStat>((JSON.parse(row?.days_json ?? '[]') as AiDayStat[]).map(day => [day.date,day]));
  const current = stored.state.models[id]?.day;
  if (current) map.set(current.date, aiDay(current));
  const result: AiModelHistory = { modelId: id, days: [...map.values()].filter(day => day.date >= new Date(since*1000).toISOString().slice(0,10)).sort((a,b) => a.date.localeCompare(b.date)),
    points: [], detailStatus: analyticsReadable(env) ? 'ready' : 'unconfigured', sampled: false };
  if (!analyticsReadable(env)) return result;
  try {
    const rows = await queryAnalytics(env, `SELECT argMax(double4,timestamp) AS checkedAt,argMax(blob1,timestamp) AS outcome,
      argMax(double1,timestamp) AS latencyMs,argMax(double3,timestamp) AS statusCode,
      argMax(blob4,timestamp) AS revision,argMax(blob5,timestamp) AS channelRevision,blob2 AS runId,
      APPROX_MAX("sampleInterval") AS sample_interval FROM ${analyticsDataset(env)}
      WHERE index1=$id AND blob3='ai_model' AND timestamp >= $ingestedSince AND double4 >= $since AND double4 <= $now
      GROUP BY runId ORDER BY checkedAt DESC LIMIT 100`, { id: `ai:${id}`, ingestedSince: new Date((since-86400)*1000).toISOString(), since, now });
    const outcomes = new Set(['ok','authentication_failed','permission_denied','model_or_endpoint_unavailable','rate_limited','quota_exhausted','rate_limit_or_quota','upstream_unavailable','request_invalid','timeout','network_error','invalid_response','response_mismatch','unexpected_status']);
    result.points = rows.filter(row => outcomes.has(String(row.outcome)) && Number.isFinite(Number(row.checkedAt)) && Number.isFinite(Number(row.latencyMs))).map(row => ({
      checkedAt: Number(row.checkedAt), outcome: row.outcome as AiHistoryPoint['outcome'], latencyMs: Number(row.latencyMs), statusCode: Number(row.statusCode),
      revision: String(row.revision), channelRevision: String(row.channelRevision), runId: String(row.runId),
    })).sort((a,b) => a.checkedAt-b.checkedAt);
    result.sampled = rows.some(row => Number(row.sample_interval)>1);
  } catch { result.detailStatus = 'unavailable'; }
  return result;
}
export function publicAiModel(model: Awaited<ReturnType<AiStore['model']>>): PublicAiModel {
  return { id: model.id, name: model.name, channel: { id: model.channelId, name: model.channelName }, intervalSec: model.intervalSec, live: model.live, recent: model.recent ?? [] };
}
