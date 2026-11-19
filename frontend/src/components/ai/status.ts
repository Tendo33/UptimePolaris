import type { AiModelLive } from '../../../../shared/ai-management';
import type { MonitorStatusKey } from '@/lib/monitor-status';
import type { Tone } from '@/types/tone';

export function aiStatusKey(live: AiModelLive): MonitorStatusKey {
  if (live.freshness !== 'current' || live.skipReason || !live.checkedAt || !live.outcome) return 'unknown';
  return live.outcome === 'ok' ? 'up' : 'down';
}

/** The `ai` catalog key describing a model's live state. / 描述模型实时状态的 `ai` 词条键。 */
export function aiLiveLabelKey(live: AiModelLive, unavailable = false): string {
  if (live.freshness === 'paused') return 'freshness.paused';
  if (unavailable) return 'staleData';
  if (live.skipReason) return `skips.${live.skipReason}`;
  if (live.freshness !== 'current') return `freshness.${live.freshness}`;
  return live.outcome ? `outcomes.${live.outcome}` : 'freshness.never_checked';
}

/** Tone for a model's live state; waiting is orange, stale or skipped is amber. / 模型实时状态色调：等待为橙色，过期或跳过为琥珀色。 */
export function aiLiveTone(live: AiModelLive, unavailable = false): Tone {
  if (live.freshness === 'paused') return 'idle';
  const key = unavailable ? 'unknown' : aiStatusKey(live);
  if (key === 'up' || key === 'down') return key;
  return unavailable || live.freshness === 'stale' || live.skipReason ? 'warn' : 'pending';
}
