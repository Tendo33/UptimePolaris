import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useFormatter, useTranslations } from 'use-intl';
import type { AiRecentCheck } from '../../../../shared/ai-management';

/**
 * A model's last scheduled checks as segments, newest on the right - the same
 * rail monitors use. Short rails are padded with empty segments so rows line up.
 * One tooltip per rail, drawn in a portal, so a long list mounts no extra trees.
 *
 * 模型最近的定时检查，按段从左到右排列，最新在右，与监控项状态条一致。
 * 检查不足时用空段补齐，使各行对齐；每条状态条只在 portal 中绘制一个提示卡。
 */
export function AiRail({ checks, max = 40, height = 'h-6', className }: { checks: AiRecentCheck[] | undefined; max?: number; height?: string; className?: string }) {
  const t = useTranslations('ai');
  const format = useFormatter();
  const recent = (checks ?? []).slice(-max);
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
  const ok = hovered?.outcome === 'ok';

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
      {recent.map((check, i) => (
        <span
          key={`${check.checkedAt}:${i}`}
          style={firstPaint.current ? { animationDelay: `${(i + pad) * 10}ms` } : undefined}
          className={clsx(
            'polaris-grow min-w-[2px] flex-1 rounded-[2px] transition-[scale,opacity] duration-150',
            check.outcome === 'ok' ? 'bg-[var(--polaris-rail-up)]' : 'bg-danger',
            hover && hover.index !== i && 'opacity-60',
            hover?.index === i && 'scale-y-[1.18]',
          )}
        />
      ))}
      {hovered && hover && typeof document !== 'undefined'
        ? createPortal(
            <div role="tooltip" className="pointer-events-none fixed z-[80] -translate-x-1/2 -translate-y-full pb-2" style={{ left: hover.x, top: hover.y }}>
              <div className="polaris-pop min-w-[9.5rem] max-w-[16rem] rounded-[9px] bg-[#111113] px-2.5 py-2 text-[11.5px] text-zinc-200 shadow-[0_10px_24px_-8px_rgb(0_0_0/0.5)] ring-1 ring-white/10">
                <div className="flex items-center gap-1.5 font-medium text-white">
                  <span className={clsx('h-1.5 w-1.5 rounded-full', ok ? 'bg-success' : 'bg-danger')} />
                  {t(`outcomes.${hovered.outcome}`)}
                  <span className="polaris-num ml-auto pl-3 text-zinc-300">{Math.round(hovered.latencyMs)}ms</span>
                </div>
                <div className="polaris-num mt-1 text-zinc-400">
                  {format.dateTime(new Date(hovered.checkedAt * 1000), { dateStyle: 'medium', timeStyle: 'medium' })}
                  {hovered.statusCode ? ` · HTTP ${hovered.statusCode}` : ''}
                </div>
              </div>
              <span className="absolute bottom-[3px] left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-[#111113]" />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}

/** Latency of the recent successful checks, for sparklines; failures are gaps. / 最近成功检查的耗时，供趋势线使用；失败记为缺口。 */
export function recentLatency(checks: AiRecentCheck[] | undefined, max = 40): Array<number | null> {
  return (checks ?? []).slice(-max).map((check) => (check.outcome === 'ok' ? check.latencyMs : null));
}
