import type { Tone } from '@/types/tone';
import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFormatter, useTranslations } from 'use-intl';
import type { SubscriptionObservation } from '../../../../shared/subscriptions';

/** Status ink for any subscription, item, run or preview state. / 订阅、条目、同步记录和预览状态共用的色调。 */
export function stateTone(value: string | null | undefined): Tone {
  switch (value) {
    case 'up':
    case 'healthy':
    case 'ready':
    case 'current':
    case 'complete':
      return 'up';
    case 'down':
    case 'failed':
      return 'down';
    case 'degraded':
    case 'partial':
    case 'stale':
    case 'configuration_changed':
      return 'warn';
    case 'pending':
    case 'running':
    case 'fetching':
    case 'parsing':
    case 'committing':
    case 'queued':
    case 'deferred':
      return 'pending';
    default:
      return 'idle';
  }
}

const FILL: Record<string, string> = {
  up: 'bg-[var(--polaris-rail-up)]',
  down: 'bg-danger',
  degraded: 'bg-warning',
  pending: 'bg-orange-500',
  maintenance: 'bg-primary/70',
  unknown: 'bg-default-300',
};

/**
 * Received observations as segments, newest on the right, padded so rows line
 * up. These are what the source reported, not checks this deployment ran.
 *
 * 已接收的观测按段排列，最新在右，不足时补空段使各行对齐。
 * 这些是来源报告的状态，并非本部署执行的检查。
 */
export function ObservationRail({
  points,
  max = 30,
  height = 'h-5',
  showLatency = true,
  className,
}: {
  points: SubscriptionObservation[] | undefined;
  max?: number;
  height?: string;
  showLatency?: boolean;
  className?: string;
}) {
  const t = useTranslations('subscriptions');
  const format = useFormatter();
  const recent = (points ?? []).slice(-max);
  const pad = Math.max(0, max - recent.length);
  const box = useRef<HTMLDivElement>(null);
  const firstPaint = useRef(true);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  useEffect(() => {
    firstPaint.current = false;
  }, []);

  const onMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const rect = box.current?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    const slot = Math.min(max - 1, Math.max(0, Math.floor(((event.clientX - rect.left) / rect.width) * max)));
    const index = slot - pad;
    if (index < 0 || index >= recent.length) return setHover(null);
    setHover({ index, x: rect.left + ((slot + 0.5) / max) * rect.width, y: rect.top });
  };

  const hovered = hover ? recent[hover.index] : undefined;
  const at = hovered ? (hovered.observedAt ?? hovered.fetchedAt) : null;

  return (
    <div
      ref={box}
      onPointerMove={onMove}
      onPointerLeave={() => setHover(null)}
      role="img"
      aria-label={recent.length ? t('railLabel', { count: recent.length }) : t('railEmpty')}
      className={clsx('flex items-stretch gap-[2px]', height, className)}
    >
      {Array.from({ length: pad }, (_, i) => (
        <span key={`pad-${i}`} className="min-w-[2px] flex-1 rounded-[2px] bg-[var(--polaris-rail-empty)]" />
      ))}
      {recent.map((point, i) => (
        <span
          key={`${point.fetchedAt}:${i}`}
          style={firstPaint.current ? { animationDelay: `${(i + pad) * 10}ms` } : undefined}
          className={clsx(
            'polaris-grow min-w-[2px] flex-1 rounded-[2px] transition-[scale,opacity] duration-150',
            FILL[point.status] ?? FILL.unknown,
            hover && hover.index !== i && 'opacity-60',
            hover?.index === i && 'scale-y-[1.18]',
          )}
        />
      ))}
      {hovered && hover && typeof document !== 'undefined'
        ? createPortal(
            <div role="tooltip" className="pointer-events-none fixed z-[80] -translate-x-1/2 -translate-y-full pb-2" style={{ left: hover.x, top: hover.y }}>
              <div className="polaris-pop min-w-[9.5rem] max-w-[17rem] rounded-[9px] bg-[#111113] px-2.5 py-2 text-[11.5px] text-zinc-200 shadow-[0_10px_24px_-8px_rgb(0_0_0/0.5)] ring-1 ring-white/10">
                <div className="flex items-center gap-1.5 font-medium text-white">
                  <span className={clsx('h-1.5 w-1.5 rounded-full', FILL[hovered.status] ?? FILL.unknown)} />
                  {t(`status.${hovered.status}`)}
                  {showLatency && hovered.latencyMs !== null ? <span className="polaris-num ml-auto pl-3 text-zinc-300">{Math.round(hovered.latencyMs)}ms</span> : null}
                </div>
                {at ? <div className="polaris-num mt-1 text-zinc-400">{format.dateTime(new Date(at * 1000), { dateStyle: 'medium', timeStyle: 'short' })}</div> : null}
                {hovered.reason ? <div className="mt-1 line-clamp-3 break-words text-zinc-400">{hovered.reason}</div> : null}
              </div>
              <span className="absolute bottom-[3px] left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-[#111113]" />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

const MIX: Array<{ tone: Tone; fill: string }> = [
  { tone: 'down', fill: 'bg-danger' },
  { tone: 'warn', fill: 'bg-warning' },
  { tone: 'pending', fill: 'bg-orange-500' },
  { tone: 'up', fill: 'bg-[var(--polaris-rail-up)]' },
  { tone: 'idle', fill: 'bg-default-300' },
];

/** A thin bar split by how many items sit in each tone. / 按各色调条目数量分段的细条。 */
export function ToneMix({ counts, className }: { counts: Partial<Record<Tone, number>>; className?: string }) {
  const total = MIX.reduce((sum, row) => sum + (counts[row.tone] ?? 0), 0);
  return (
    <span aria-hidden="true" className={clsx('flex h-1.5 gap-px overflow-hidden rounded-full bg-[var(--polaris-rail-empty)]', className)}>
      {total
        ? MIX.map((row) => {
            const n = counts[row.tone] ?? 0;
            return n ? <span key={row.tone} className={clsx('h-full', row.fill)} style={{ width: `${(n / total) * 100}%` }} /> : null;
          })
        : null}
    </span>
  );
}

/** Count tones, from a list of tones or from per-status counts. / 统计色调数量，可传入色调列表或按状态的计数。 */
export function toneCounts(source: Tone[] | Partial<Record<string, number>> | undefined): Partial<Record<Tone, number>> {
  const counts: Partial<Record<Tone, number>> = {};
  if (Array.isArray(source)) for (const tone of source) counts[tone] = (counts[tone] ?? 0) + 1;
  else for (const [status, n] of Object.entries(source ?? {})) if (n) counts[stateTone(status)] = (counts[stateTone(status)] ?? 0) + n;
  return counts;
}
