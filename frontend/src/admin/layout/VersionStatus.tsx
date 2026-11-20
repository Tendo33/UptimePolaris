import { useBackendCapabilities } from '@/api/backend';
import { Popover } from '@/components/ui/MotionOverlays';
import { useTimeAgo } from '@/hooks/useTimeAgo';
import { PROJECT_REPOSITORY_URL } from '@/lib/project';
import { APP_VERSION } from '@/lib/version';
import { Button, PopoverContent, PopoverTrigger } from '@heroui/react';
import clsx from 'clsx';
import { AlertCircle, ArrowRight, ArrowUpRight, BellOff, BookOpen, CircleCheck, RefreshCw, Sparkles } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { useLocale, useTranslations } from 'use-intl';

const CACHE_KEY = 'uptime-polaris.latest-version';
const DISMISS_KEY = 'uptime-polaris.dismissed-version';
const REFRESH_MS = 6 * 60 * 60 * 1000;
const repository = new URL(PROJECT_REPOSITORY_URL).pathname.replace(/^\//, '');
const tagsUrl = `https://api.github.com/repos/${repository}/tags?per_page=100`;
const stableTag = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\+[\w.-]+)?$/;
type VersionCheck = { tag: string | null; checkedAt: number };

function compareVersions(left: string, right: string): number {
  const a = left.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(BigInt);
  const b = right.replace(/^v/, '').split(/[.+-]/).slice(0, 3).map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function cachedCheck(): VersionCheck | undefined {
  try {
    const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null');
    if (value && (value.tag === null || typeof value.tag === 'string' && stableTag.test(value.tag)) && Number.isFinite(value.checkedAt) && value.checkedAt <= Date.now() && Date.now() - value.checkedAt < REFRESH_MS) return value;
  } catch {}
}

async function checkVersion(): Promise<VersionCheck> {
  const signal = AbortSignal.timeout(15_000);
  let latest: string | null = null;
  for (let page = 1; ; page++) {
    const response = await fetch(`${tagsUrl}&page=${page}`, { credentials: 'omit', referrerPolicy: 'no-referrer', headers: { accept: 'application/vnd.github+json' }, signal });
    if (!response.ok) throw new Error('version_check_failed');
    const tags: unknown = await response.json();
    if (!Array.isArray(tags)) throw new Error('version_check_failed');
    for (const tag of tags) {
      if (typeof tag?.name === 'string' && stableTag.test(tag.name) && (!latest || compareVersions(tag.name, latest) > 0)) latest = tag.name;
    }
    if (!response.headers.get('link')?.includes('rel="next"')) break;
  }
  const result = { tag: latest, checkedAt: Date.now() };
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(result)); } catch {}
  return result;
}

function readDismissed(): string | null {
  try { return localStorage.getItem(DISMISS_KEY); } catch { return null; }
}

const bare = (version: string) => version.replace(/^v/, '');

export function VersionStatus() {
  const t = useTranslations('admin.versionStatus');
  const locale = useLocale();
  const ago = useTimeAgo();
  const runtime = useBackendCapabilities().data?.runtime;
  const [cached] = useState(cachedCheck);
  const [dismissed, setDismissed] = useState(readDismissed);
  const resource = useSWR(tagsUrl, checkVersion, {
    fallbackData: cached, revalidateOnMount: !cached, revalidateOnFocus: false, revalidateOnReconnect: false,
    refreshInterval: REFRESH_MS, dedupingInterval: 60_000, shouldRetryOnError: false,
  });
  const latest = resource.data?.tag ?? null;
  const comparable = /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(APP_VERSION);
  const prerelease = !comparable || APP_VERSION.includes('-');
  const available = Boolean(latest && comparable && (compareVersions(latest, APP_VERSION) > 0 || compareVersions(latest, APP_VERSION) === 0 && APP_VERSION.includes('-')));
  const quiet = available && dismissed === latest;
  const loud = available && !quiet;
  const checking = resource.isValidating;
  const failed = Boolean(resource.error);

  const tagPrefix = latest?.startsWith('v') ? 'v' : '';
  const changesUrl = latest
    ? /^\d+\.\d+\.\d+$/.test(bare(APP_VERSION)) && available
      ? `${PROJECT_REPOSITORY_URL}/compare/${tagPrefix}${bare(APP_VERSION)}...${encodeURIComponent(latest)}`
      : `${PROJECT_REPOSITORY_URL}/commits/${encodeURIComponent(latest)}`
    : `${PROJECT_REPOSITORY_URL}/releases`;
  const guideUrl = `${PROJECT_REPOSITORY_URL}/blob/main/docs/operations.md#${locale.startsWith('zh') ? encodeURIComponent('升级流程') : 'upgrade'}`;
  const label = available ? t('available', { version: latest! }) : t('check');

  const dismiss = () => {
    if (!latest) return;
    try { localStorage.setItem(DISMISS_KEY, latest); } catch {}
    setDismissed(latest);
  };
  const undismiss = () => {
    try { localStorage.removeItem(DISMISS_KEY); } catch {}
    setDismissed(null);
  };

  const state = failed ? 'failed' : available ? 'available' : latest ? 'latest' : 'none';
  const Icon = state === 'failed' ? AlertCircle : state === 'available' ? Sparkles : CircleCheck;

  return (
    <Popover placement="bottom-start" offset={8}>
      <PopoverTrigger>
        <button
          type="button"
          aria-label={label}
          title={label}
          className={clsx(
            'hidden h-7 shrink-0 items-center gap-1.5 rounded-full pr-1 pl-2 text-[12px] transition-colors sm:inline-flex',
            loud ? 'bg-[var(--polaris-active)] text-[var(--polaris-accent)] ring-1 ring-[var(--polaris-accent)]/25 hover:ring-[var(--polaris-accent)]/45' : 'text-[var(--polaris-ink-3)] hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink-2)]',
            !loud && 'pr-2',
          )}
        >
          <span className="polaris-num font-mono">v{bare(APP_VERSION)}</span>
          {loud ? (
            <span className="inline-flex h-5 items-center gap-1 rounded-full bg-[var(--polaris-accent)] px-1.5 text-[10.5px] font-semibold text-white">
              <span className="relative flex h-1.5 w-1.5">
                <span className="absolute inset-0 animate-ping rounded-full bg-white/70 motion-reduce:hidden" />
                <span className="relative h-1.5 w-1.5 rounded-full bg-white" />
              </span>
              {t('newBadge')}
            </span>
          ) : quiet ? (
            <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-[var(--polaris-accent)]/60" />
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-[19.5rem] items-stretch gap-0 overflow-hidden border border-[var(--polaris-line)] bg-[var(--polaris-card)] p-0 text-[var(--polaris-ink)]">
        <div className="flex items-start gap-3 px-4 pt-4 pb-3">
          <span
            aria-hidden="true"
            className={clsx(
              'flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border',
              state === 'available' ? 'border-transparent bg-[var(--polaris-accent)] text-white' : state === 'failed' ? 'border-danger/20 bg-danger/[0.06] text-danger-600' : state === 'latest' ? 'border-success/25 bg-success/[0.08] text-success-700' : 'border-[var(--polaris-line)] bg-[var(--polaris-well)] text-[var(--polaris-ink-3)]',
            )}
          >
            <Icon size={17} />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[14px] font-semibold">{t('title')}</p>
            <p role={failed ? 'alert' : 'status'} className={clsx('mt-0.5 text-[12.5px] leading-snug', failed ? 'text-danger-600' : 'text-[var(--polaris-ink-3)]')}>
              {failed ? t('failed') : checking && !latest ? t('checking') : available ? label : !latest ? t('noTags') : comparable ? t('currentLatest') : t('latest', { version: latest })}
            </p>
          </div>
        </div>

        <div className="mx-4 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 rounded-xl bg-[var(--polaris-well)] px-3 py-2.5">
          <div className="min-w-0">
            <p className="text-[11px] text-[var(--polaris-ink-4)]">{t('currentLabel')}</p>
            <p className="flex items-center gap-1.5 truncate font-mono text-[13px] font-medium">
              v{bare(APP_VERSION)}
              {prerelease ? <span className="rounded bg-warning/15 px-1 font-sans text-[10px] font-medium text-warning-700">{t('devBuild')}</span> : null}
            </p>
          </div>
          <ArrowRight size={14} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
          <div className="min-w-0 text-right">
            <p className="text-[11px] text-[var(--polaris-ink-4)]">{t('latestLabel')}</p>
            <p className={clsx('truncate font-mono text-[13px] font-medium', available ? 'text-[var(--polaris-accent)]' : 'text-[var(--polaris-ink)]')}>
              {latest ? `v${bare(latest)}` : checking ? '…' : '—'}
            </p>
          </div>
        </div>

        {available ? (
          <p className="mx-4 mt-3 text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">{t(runtime === 'go' ? 'goHint' : 'workerHint')}</p>
        ) : null}

        <div className="flex flex-col gap-1 px-2 pt-3 pb-2">
          {latest ? (
            <a href={changesUrl} target="_blank" rel="noopener noreferrer" className="flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-[var(--polaris-hover)]">
              <ArrowUpRight size={14} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
              <span className="flex-1">{available ? t('releaseNotes') : t('changes', { version: latest })}</span>
            </a>
          ) : null}
          {available ? (
            <a href={guideUrl} target="_blank" rel="noopener noreferrer" className="flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-[var(--polaris-hover)]">
              <BookOpen size={14} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
              <span className="flex-1">{t('upgradeGuide')}</span>
            </a>
          ) : (
            <a href={`${PROJECT_REPOSITORY_URL}/releases`} target="_blank" rel="noopener noreferrer" className="flex h-8 items-center gap-2 rounded-lg px-2 text-[13px] transition-colors hover:bg-[var(--polaris-hover)]">
              <BookOpen size={14} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
              <span className="flex-1">{t('releases')}</span>
            </a>
          )}
          {available ? (
            quiet ? (
              <button type="button" onClick={undismiss} className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] text-[var(--polaris-ink-3)] transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]">
                <BellOff size={14} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
                <span className="flex-1">{t('dismissed')}</span>
                <span className="text-[12px] underline underline-offset-4">{t('undo')}</span>
              </button>
            ) : (
              <button type="button" onClick={dismiss} className="flex h-8 items-center gap-2 rounded-lg px-2 text-left text-[13px] text-[var(--polaris-ink-3)] transition-colors hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]">
                <BellOff size={14} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
                <span className="flex-1">{t('dismiss')}</span>
              </button>
            )
          ) : null}
        </div>

        <div className="flex items-center gap-2 border-t border-[var(--polaris-line-soft)] px-4 py-2.5 text-[11.5px] text-[var(--polaris-ink-4)]">
          <span className="min-w-0 flex-1 truncate">
            {resource.data?.checkedAt ? t('checkedAt', { time: ago(Math.floor(resource.data.checkedAt / 1000)) }) : t('notChecked')}
          </span>
          <Button
            size="sm"
            variant="light"
            className="h-7 min-w-0 gap-1.5 px-2 text-[12px]"
            isLoading={checking}
            startContent={checking ? undefined : <RefreshCw size={12} />}
            onPress={() => void resource.mutate().catch(() => undefined)}
          >
            {checking ? t('checking') : t('check')}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
