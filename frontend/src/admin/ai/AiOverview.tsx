import { CircleAlert, CircleCheck, CircleDashed, Layers } from 'lucide-react';
import { useTranslations } from 'use-intl';
import type { AiModel } from '../../../../shared/ai-management';
import { StatBand, StatCell } from '../components/SummaryStats';
import { bucketCounts, type AiBucket } from './presentation';

/**
 * Four figures over the list: how many models, and how many are fine, failing
 * or not confirmed. The last three filter the list below.
 *
 * 列表上方的四个指标：模型总数，以及可用、异常、未确认的数量；后三项可筛选下方列表。
 */
export function AiOverview({
  models,
  channels,
  unavailable,
  filter,
  onFilter,
}: {
  models: AiModel[];
  /** Channel count on the overview; null inside one channel. / 总览页传入渠道数；渠道详情传 null。 */
  channels: number | null;
  unavailable: boolean;
  filter: AiBucket | null;
  onFilter: (bucket: AiBucket | null) => void;
}) {
  const t = useTranslations('admin.ai');
  const counts = bucketCounts(models, unavailable);
  const enabled = models.length - counts.paused;
  const toggle = (bucket: AiBucket) => onFilter(filter === bucket ? null : bucket);

  return (
    <StatBand className="grid-cols-2 lg:grid-cols-4">
      <StatCell
        label={t('statModels')}
        icon={<Layers />}
        value={counts.total}
        sub={channels === null ? t('statEnabled', { count: enabled }) : t('statModelsSub', { channels, count: enabled })}
        onPress={filter === null ? undefined : () => onFilter(null)}
      />
      <StatCell label={t('bucket.up')} icon={<CircleCheck />} value={counts.up} sub={t('statUpSub')} active={filter === 'up'} onPress={() => toggle('up')} />
      <StatCell
        label={t('bucket.down')}
        icon={<CircleAlert />}
        value={counts.down}
        tone={counts.down > 0 ? 'down' : undefined}
        sub={t('statDownSub')}
        active={filter === 'down'}
        onPress={() => toggle('down')}
      />
      <StatCell
        label={t('bucket.unknown')}
        icon={<CircleDashed />}
        value={counts.unknown}
        tone={counts.unknown > 0 ? 'warn' : undefined}
        sub={counts.paused ? t('statPausedSub', { count: counts.paused }) : t('statUnknownSub')}
        active={filter === 'unknown'}
        onPress={() => toggle('unknown')}
      />
    </StatBand>
  );
}
