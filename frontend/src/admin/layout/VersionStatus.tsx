import { Popover } from '@/components/ui/MotionOverlays';
import { PROJECT_REPOSITORY_URL } from '@/lib/project';
import { APP_VERSION } from '@/lib/version';
import { Button, PopoverContent, PopoverTrigger } from '@heroui/react';
import clsx from 'clsx';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'use-intl';

const CACHE_KEY = 'uptime-polaris.latest-version';
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

export function VersionStatus() {
  const t = useTranslations('admin.versionStatus');
  const [cached] = useState(cachedCheck);
  const resource = useSWR(tagsUrl, checkVersion, {
    fallbackData: cached, revalidateOnMount: !cached, revalidateOnFocus: false, revalidateOnReconnect: false,
    refreshInterval: REFRESH_MS, dedupingInterval: 60_000, shouldRetryOnError: false,
  });
  const latest = resource.data?.tag;
  const comparable = /^v?\d+\.\d+\.\d+(?:[-+].*)?$/.test(APP_VERSION);
  const available = Boolean(latest && comparable && (compareVersions(latest, APP_VERSION) > 0 || compareVersions(latest, APP_VERSION) === 0 && APP_VERSION.includes('-')));
  const label = available ? t('available', { version: latest! }) : t('check');
  return (
    <Popover placement="bottom-start">
      <PopoverTrigger>
        <button type="button" aria-label={label} title={label} className={clsx('hidden min-h-8 shrink-0 items-center gap-1 rounded-lg px-1.5 text-[12px] sm:inline-flex', available ? 'text-[var(--polaris-accent)] hover:bg-[var(--polaris-active)]' : 'text-[var(--polaris-ink-3)] hover:bg-[var(--polaris-hover)]')}>
          <span className="font-mono">v{APP_VERSION}</span>
          {available ? <ArrowUpRight size={13} aria-hidden="true" /> : null}
        </button>
      </PopoverTrigger>
      <PopoverContent className="max-w-72 items-stretch gap-3 border border-[var(--polaris-line)] bg-[var(--polaris-card)] p-4 text-[var(--polaris-ink)]">
        <div>
          <p className="text-[14px] font-semibold">{t('title')}</p>
          <p className="mt-1 text-[12px] text-[var(--polaris-ink-3)]">{t('current', { version: APP_VERSION })}</p>
        </div>
        <p role={resource.error ? 'alert' : 'status'} className={clsx('text-[13px] leading-relaxed', resource.error && 'text-danger')}>
          {resource.error ? t('failed') : resource.isValidating ? t('checking') : available ? label : !latest ? t('noTags') : comparable ? t('currentLatest') : t('latest', { version: latest })}
        </p>
        {latest ? <a href={`${PROJECT_REPOSITORY_URL}/commits/${encodeURIComponent(latest)}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-[13px] underline underline-offset-4">{t('changes', { version: latest })}<ArrowUpRight size={13} /></a> : null}
        <Button size="sm" variant="flat" isLoading={resource.isValidating} startContent={!resource.isValidating ? <RefreshCw size={13} /> : undefined} onPress={() => void resource.mutate().catch(() => undefined)}>{t('check')}</Button>
      </PopoverContent>
    </Popover>
  );
}
