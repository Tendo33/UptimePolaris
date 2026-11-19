import { Segmented } from '@/components/ui/Segmented';
import { StatusDot } from '@/components/ui/StatusDot';
import { Select } from '@/components/ui/MotionOverlays';
import { Input, SelectItem } from '@heroui/react';
import clsx from 'clsx';
import { ArrowDownUp, Search, X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import type { AiManualResult } from '../../../../shared/ai-management';
import type { AiProtocol } from '../../../../shared/ai-probe';
import { AI_BUCKETS, AI_SORTS, PROTOCOL_SHORT, type AiBucket, type AiSort } from './presentation';

/** The list frame shared by channels and models: toolbar, rows, footer. / 渠道与模型列表共用的框架：工具栏、列表行、页脚。 */
export function ListFrame({ toolbar, footer, busy, children }: { toolbar: ReactNode; footer: ReactNode; busy?: boolean; children: ReactNode }) {
  return (
    <section className={clsx('polaris-card flex min-h-[18rem] flex-1 flex-col overflow-hidden', busy && 'polaris-sweep')}>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--polaris-line)] px-3 py-2.5">{toolbar}</div>
      <div className="min-h-0 flex-1">{children}</div>
      <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--polaris-line)] px-4 py-2.5 text-[12px] text-[var(--polaris-ink-3)]">{footer}</div>
    </section>
  );
}

export function ListToolbar({
  counts,
  filter,
  onFilter,
  query,
  onQuery,
  placeholder,
  leading,
  extra,
}: {
  counts: Record<AiBucket | 'total', number>;
  filter: AiBucket | null;
  onFilter: (bucket: AiBucket | null) => void;
  query: string;
  onQuery: (query: string) => void;
  placeholder: string;
  /** Left of the filters, such as a select-all box. / 筛选器左侧内容，例如全选框。 */
  leading?: ReactNode;
  /** Left of the search box, such as a sort menu. / 搜索框左侧内容，例如排序菜单。 */
  extra?: ReactNode;
}) {
  const t = useTranslations('admin.ai');
  const action = useTranslations('admin.action');
  const options = AI_BUCKETS.filter((bucket) => counts[bucket] > 0 || filter === bucket).map((bucket) => ({
    value: bucket as string,
    label: t(`bucket.${bucket}`),
    count: counts[bucket],
  }));
  return (
    <>
      {leading}
      <Segmented
        label={t('statusFilter')}
        value={filter ?? 'all'}
        onChange={(value) => onFilter(value === 'all' ? null : (value as AiBucket))}
        options={[{ value: 'all', label: t('filterAll'), count: counts.total }, ...options]}
      />
      <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
        {extra}
        <Input
          size="sm"
          className="w-full sm:w-60"
          aria-label={placeholder}
          placeholder={placeholder}
          value={query}
          onValueChange={onQuery}
          startContent={<Search className="shrink-0 text-[var(--polaris-ink-4)]" size={14} />}
          endContent={
            query ? (
              <button type="button" aria-label={action('cancel')} onClick={() => onQuery('')} className="text-[var(--polaris-ink-4)] transition-colors hover:text-[var(--polaris-ink)]">
                <X size={14} />
              </button>
            ) : null
          }
        />
      </div>
    </>
  );
}

export function SortSelect({ value, onChange }: { value: AiSort; onChange: (value: AiSort) => void }) {
  const t = useTranslations('admin.ai');
  return (
    <Select
      size="sm"
      aria-label={t('sortLabel')}
      className="w-full sm:w-40"
      selectedKeys={[value]}
      disallowEmptySelection
      startContent={<ArrowDownUp size={13} className="shrink-0 text-[var(--polaris-ink-4)]" />}
      onChange={(event) => {
        if (AI_SORTS.includes(event.target.value as AiSort)) onChange(event.target.value as AiSort);
      }}
    >
      {AI_SORTS.map((sort) => (
        <SelectItem key={sort} textValue={t(`sort.${sort}`)}>
          {t(`sort.${sort}`)}
        </SelectItem>
      ))}
    </Select>
  );
}

export function ListFooter({ shown, total, refreshInterval, label }: { shown: number; total: number; refreshInterval: number; label: 'footChannels' | 'footModels' }) {
  const t = useTranslations('admin.ai');
  return (
    <>
      <span className="polaris-num">{t(label, { shown, total })}</span>
      <span className="flex items-center gap-1.5">
        <span className="polaris-live h-1.5 w-1.5 rounded-full bg-success" />
        {t('autoRefresh', { seconds: refreshInterval / 1000 })}
      </span>
    </>
  );
}

export function ProtocolChip({ protocol }: { protocol: AiProtocol }) {
  const t = useTranslations('admin.ai');
  return (
    <span title={t(protocol)} className="inline-flex h-[20px] shrink-0 items-center rounded-md border border-[var(--polaris-line)] bg-[var(--polaris-well)] px-1.5 text-[11px] font-medium text-[var(--polaris-ink-2)]">
      {PROTOCOL_SHORT[protocol]}
    </span>
  );
}

/** One manual check result, labelled so it is not mistaken for the scheduled state. / 单次手动检查结果，带标签以免与定时状态混淆。 */
export function ManualResult({ result, label, className }: { result: AiManualResult; label: string; className?: string }) {
  const t = useTranslations('admin.ai');
  const format = useFormatter();
  const ok = result.outcome === 'ok';
  const soft = result.outcome === 'models_endpoint_unsupported';
  return (
    <p className={clsx('flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[12px] text-[var(--polaris-ink-3)]', className)}>
      <span className="text-[var(--polaris-ink-4)]">{label}</span>
      <span className={clsx('flex items-center gap-1.5 font-medium', ok ? 'text-success-700' : soft ? 'text-warning-700' : 'text-danger-600')}>
        <StatusDot tone={ok ? 'up' : soft ? 'warn' : 'down'} size={6} />
        {t(`outcomes.${result.outcome}`)}
      </span>
      <time dateTime={new Date(result.checkedAt * 1000).toISOString()}>
        {format.dateTime(new Date(result.checkedAt * 1000), { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
      </time>
      <span className="polaris-num">{Math.round(result.latencyMs)} ms</span>
      {result.statusCode ? <span className="polaris-num">HTTP {result.statusCode}</span> : null}
    </p>
  );
}

/** Availability ink: neutral when healthy, amber then red as it drops. / 可用率颜色：正常为中性色，下降时依次变为琥珀色和红色。 */
export function availabilityInk(value: number | null) {
  if (value === null) return 'text-[var(--polaris-ink-4)]';
  if (value >= 99) return 'text-[var(--polaris-ink)]';
  if (value >= 95) return 'text-warning-700';
  return 'text-danger-600';
}
