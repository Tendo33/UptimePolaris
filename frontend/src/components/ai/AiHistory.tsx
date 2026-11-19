import { requestJson } from '@/api/client';
import { ApiError, isRetryableApiError } from '@/api/errors';
import { SparkLine } from '@/components/ui/MetricFigures';
import { Segmented } from '@/components/ui/Segmented';
import clsx from 'clsx';
import { useState } from 'react';
import useSWR from 'swr';
import { useFormatter, useTranslations } from 'use-intl';
import type { AiDayStat, AiModelHistory, AiRecentCheck } from '../../../../shared/ai-management';
import { AiRail } from './AiRail';

const RANGES = [7, 30, 90] as const;
type Range = (typeof RANGES)[number];
const TABLE_ROWS = 7;
const RECENT_ROWS = 12;

/** Ink and fill per availability band; healthy stays neutral so a bad day stands out. / 按可用率分档的颜色；正常保持中性，让异常日更醒目。 */
function band(value: number | null) {
  if (value === null) return { ink: 'text-[var(--polaris-ink-4)]', fill: 'bg-[var(--polaris-rail-empty)]' };
  if (value >= 99) return { ink: 'text-[var(--polaris-ink)]', fill: 'bg-[var(--polaris-rail-up)]' };
  if (value >= 95) return { ink: 'text-warning-700', fill: 'bg-warning' };
  return { ink: 'text-danger-600', fill: 'bg-danger' };
}

function totals(days: AiDayStat[]) {
  let total = 0;
  let ok = 0;
  let latency = 0;
  for (const day of days) {
    total += day.total;
    ok += day.ok;
    if (day.avgLatencyMs !== null) latency += day.avgLatencyMs * day.total;
  }
  return { total, ok, availability: total ? (ok * 100) / total : null, latency: total ? latency / total : null };
}

/** Every UTC date in the range, oldest first, with the stat when the day has one. / 范围内每个 UTC 日期（从旧到新），有统计时附带当天数据。 */
function calendar(days: AiDayStat[], range: Range) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const today = Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate());
  return Array.from({ length: range }, (_, index) => {
    const date = new Date(today - (range - 1 - index) * 86_400_000).toISOString().slice(0, 10);
    return { date, stat: byDate.get(date) ?? null };
  });
}

/**
 * A model's history: availability per day over a chosen range, the latency
 * trend, and the latest checks. Shared by the console drawer and the public page.
 * `recent` fills the latest checks when the detail endpoint has none.
 *
 * 模型历史：所选范围内的每日可用率、耗时趋势和最近检查；控制台抽屉和公开页共用。
 * 明细接口没有数据时，用 `recent` 显示最近检查。
 */
export function AiHistory({ url, recent }: { url: (days: number) => string; recent?: AiRecentCheck[] }) {
  const t = useTranslations('ai');
  const format = useFormatter();
  const [range, setRange] = useState<Range>(7);
  const [allDays, setAllDays] = useState(false);
  const [allChecks, setAllChecks] = useState(false);
  const resource = useSWR(url(range), requestJson<AiModelHistory>, { revalidateOnFocus: false, keepPreviousData: true, shouldRetryOnError: isRetryableApiError, errorRetryCount: 1 });
  const revoked = resource.error instanceof ApiError && [401, 403, 404].includes(resource.error.status);
  const data = revoked ? undefined : resource.data;
  const pct = (value: number | null) => (value === null ? '—' : `${format.number(value, { maximumFractionDigits: 2 })}%`);
  const ms = (value: number | null) => (value === null ? '—' : `${format.number(Math.round(value))} ms`);
  const day = (date: string, options: Pick<Intl.DateTimeFormatOptions, 'year' | 'month' | 'day' | 'weekday'>) => format.dateTime(new Date(`${date}T00:00:00Z`), { ...options, timeZone: 'UTC' });

  const rangePicker = (
    <Segmented
      label={t('rangeLabel')}
      value={String(range)}
      onChange={(value) => {
        setRange(Number(value) as Range);
        setAllDays(false);
      }}
      options={RANGES.map((value) => ({ value: String(value), label: t('range', { days: value }) }))}
    />
  );

  if (resource.error && !data) {
    return (
      <div className="flex flex-col gap-4">
        {rangePicker}
        <div role="alert" className="text-small text-danger">
          <p>{t(revoked ? 'historyHidden' : 'loadFailed')}</p>
          {!revoked ? (
            <button type="button" className="mt-2 underline underline-offset-4" onClick={() => void resource.mutate().catch(() => undefined)}>
              {t('retry')}
            </button>
          ) : null}
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div role="status" aria-busy="true" className="flex flex-col gap-3">
        <span className="polaris-shimmer h-7 w-48 rounded-lg" />
        <span className="polaris-shimmer h-[72px] rounded-xl" />
        <span className="polaris-shimmer h-40 rounded-xl" />
        <span className="sr-only">{t('loading')}</span>
      </div>
    );
  }

  const sum = totals(data.days);
  const cells = calendar(data.days, range);
  const latency = cells.map((cell) => cell.stat?.avgLatencyMs ?? null);
  const latencyValues = latency.filter((value): value is number => value !== null);
  const rows = data.days.slice().reverse();
  const checks: AiRecentCheck[] = data.points.length ? data.points : (recent ?? []);
  const listed = checks.slice().reverse();

  return (
    <div className={clsx('flex min-w-0 flex-col gap-7 transition-opacity', resource.isValidating && 'opacity-70')}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        {rangePicker}
        {resource.error ? <span className="text-[12px] text-warning-700">{t('staleData')}</span> : null}
      </div>

      <dl className="polaris-card grid grid-cols-3 overflow-hidden">
        {[
          { label: t('summaryAvailability', { days: range }), value: pct(sum.availability), ink: band(sum.availability).ink },
          { label: t('avgLatency'), value: ms(sum.latency), ink: 'text-[var(--polaris-ink)]' },
          { label: t('summaryChecks'), value: format.number(sum.total), ink: 'text-[var(--polaris-ink)]' },
        ].map((item, index) => (
          <div key={item.label} className={clsx('min-w-0 px-4 py-3.5', index > 0 && 'border-l border-[var(--polaris-line-soft)]')}>
            <dt className="truncate text-[12px] text-[var(--polaris-ink-3)]">{item.label}</dt>
            <dd className={clsx('polaris-num mt-1 truncate text-[14px] leading-tight font-semibold tracking-[-0.02em]', item.ink)}>{item.value}</dd>
          </div>
        ))}
      </dl>

      <section>
        <div className="flex items-baseline justify-between gap-3">
          <h3 className="text-[13px] font-semibold text-[var(--polaris-ink)]">{t('dailyStrip')}</h3>
          <span className="text-[11.5px] text-[var(--polaris-ink-4)]">{t('utcNote')}</span>
        </div>
        <p className="mt-0.5 text-[12px] text-[var(--polaris-ink-3)]">{t('dailyHint')}</p>
        <div className="mt-3 flex h-8 items-stretch gap-[2px]">
          {cells.map((cell) => (
            <span
              key={cell.date}
              title={
                cell.stat
                  ? `${day(cell.date, { month: 'numeric', day: 'numeric' })} · ${pct(cell.stat.availabilityPct)} · ${format.number(cell.stat.ok)}/${format.number(cell.stat.total)} · ${ms(cell.stat.avgLatencyMs)}`
                  : `${day(cell.date, { month: 'numeric', day: 'numeric' })} · ${t('noChecks')}`
              }
              className={clsx('min-w-[2px] flex-1 rounded-[2px] transition-opacity hover:opacity-70', band(cell.stat?.availabilityPct ?? null).fill)}
            />
          ))}
        </div>
        <div className="mt-1.5 flex justify-between text-[12px] text-[var(--polaris-ink-4)]">
          <span>{day(cells[0].date, { month: 'numeric', day: 'numeric' })}</span>
          <span>{t('today')}</span>
        </div>

        {latencyValues.length > 1 ? (
          <div className="mt-5">
            <div className="flex items-baseline justify-between gap-3 text-[12px] text-[var(--polaris-ink-3)]">
              <span>{t('latencyTrend')}</span>
              <span className="polaris-num">
                {ms(Math.min(...latencyValues))} – {ms(Math.max(...latencyValues))}
              </span>
            </div>
            <SparkLine values={latency} height={48} className="mt-2 text-[var(--polaris-chart)]" label={t('latencyTrend')} />
          </div>
        ) : null}

        {rows.length ? (
          <>
            <table className="mt-5 w-full text-left text-[12.5px] tabular-nums">
              <thead className="text-[11.5px] text-[var(--polaris-ink-4)]">
                <tr>
                  <th className="pb-1.5 font-normal">{t('date')}</th>
                  <th className="pb-1.5 font-normal">{t('availability')}</th>
                  <th className="hidden pb-1.5 text-right font-normal sm:table-cell">{t('checks')}</th>
                  <th className="pb-1.5 text-right font-normal">{t('avgLatency')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--polaris-line-soft)] border-t border-[var(--polaris-line-soft)]">
                {(allDays ? rows : rows.slice(0, TABLE_ROWS)).map((stat) => {
                  const shade = band(stat.availabilityPct);
                  return (
                    <tr key={stat.date}>
                      <td className="w-[6.5rem] py-2.5 pr-3 whitespace-nowrap text-[var(--polaris-ink-2)]">
                        {day(stat.date, { month: 'numeric', day: 'numeric' })}
                        <span className="ml-1.5 text-[var(--polaris-ink-4)]">{day(stat.date, { weekday: 'short' })}</span>
                      </td>
                      <td className="py-2.5 pr-3">
                        <span className="flex items-center gap-2.5">
                          <span aria-hidden="true" className="h-1.5 min-w-12 flex-1 overflow-hidden rounded-full bg-[var(--polaris-rail-empty)]">
                            <span className={clsx('block h-full rounded-full', shade.fill)} style={{ width: `${stat.availabilityPct ?? 0}%` }} />
                          </span>
                          <span className={clsx('w-16 shrink-0 text-right font-medium', shade.ink)}>{pct(stat.availabilityPct)}</span>
                        </span>
                      </td>
                      <td className="hidden py-2.5 pr-3 text-right whitespace-nowrap text-[var(--polaris-ink-3)] sm:table-cell">
                        {format.number(stat.ok)} / {format.number(stat.total)}
                      </td>
                      <td className="py-2.5 text-right whitespace-nowrap text-[var(--polaris-ink-2)]">{ms(stat.avgLatencyMs)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {rows.length > TABLE_ROWS ? (
              <button type="button" onClick={() => setAllDays((value) => !value)} className="mt-2 text-[12.5px] text-[var(--polaris-ink-2)] underline underline-offset-4 hover:text-[var(--polaris-ink)]">
                {allDays ? t('showLess') : t('showAll', { count: rows.length })}
              </button>
            ) : null}
          </>
        ) : (
          <p className="mt-3 text-small text-[var(--polaris-ink-3)]">{t('noHistory')}</p>
        )}
      </section>

      <section>
        <h3 className="text-[13px] font-semibold text-[var(--polaris-ink)]">{t('recentTitle')}</h3>
        {!checks.length && data.detailStatus !== 'ready' ? (
          <p role="status" className="mt-1 text-[12px] text-[var(--polaris-ink-3)]">
            {t(`detail.${data.detailStatus}`)}
          </p>
        ) : null}
        {data.sampled && data.points.length ? <p className="mt-1 text-[12px] text-[var(--polaris-ink-3)]">{t('sampled')}</p> : null}
        {checks.length ? (
          <>
            <AiRail checks={checks} max={60} className="mt-3" />
            <ol className="mt-4 divide-y divide-[var(--polaris-line-soft)]">
              {(allChecks ? listed : listed.slice(0, RECENT_ROWS)).map((point, index) => (
                <li key={`${point.checkedAt}:${index}`} className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-0.5 py-2.5 text-[12.5px] sm:grid-cols-[9rem_minmax(0,1fr)_auto]">
                  <time dateTime={new Date(point.checkedAt * 1000).toISOString()} className="text-[var(--polaris-ink-3)]">
                    {format.dateTime(new Date(point.checkedAt * 1000), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </time>
                  <span className={clsx('flex min-w-0 items-center gap-1.5 font-medium', point.outcome === 'ok' ? 'text-[var(--polaris-ink-2)]' : 'text-danger-600')}>
                    <span aria-hidden="true" className={clsx('h-1.5 w-1.5 shrink-0 rounded-full', point.outcome === 'ok' ? 'bg-success' : 'bg-danger')} />
                    <span className="truncate">{t(`outcomes.${point.outcome}`)}</span>
                  </span>
                  <span className="polaris-num text-right text-[var(--polaris-ink-3)]">
                    {format.number(Math.round(point.latencyMs))} ms{point.statusCode ? ` · HTTP ${point.statusCode}` : ''}
                  </span>
                </li>
              ))}
            </ol>
            {listed.length > RECENT_ROWS ? (
              <button type="button" onClick={() => setAllChecks((value) => !value)} className="mt-2 text-[12.5px] text-[var(--polaris-ink-2)] underline underline-offset-4 hover:text-[var(--polaris-ink)]">
                {allChecks ? t('showLess') : t('showAll', { count: listed.length })}
              </button>
            ) : null}
          </>
        ) : data.detailStatus === 'ready' ? (
          <p className="mt-3 text-small text-[var(--polaris-ink-3)]">{t('noHistory')}</p>
        ) : null}
      </section>
    </div>
  );
}
