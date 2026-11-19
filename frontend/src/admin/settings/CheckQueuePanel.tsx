import { useBackendCapabilities } from '@/api/backend';
import { ApiError, isRetryableApiError } from '@/api/errors';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { Button, Switch } from '@heroui/react';
import { RefreshCw, SearchCheck } from 'lucide-react';
import { useRef, useState } from 'react';
import useSWR from 'swr';
import { useFormatter, useTranslations } from 'use-intl';
import type { CheckQueueStatus } from '../../../../shared/check-queue';
import { StatusPill } from '../monitors/MonitorIndicators';
import type { Tone } from '../../types/tone';
import { checkQueueApi } from './check-queue-api';

export function CheckQueuePanel() {
  const backend = useBackendCapabilities();
  return backend.data?.runtime === 'worker' ? <WorkerCheckQueue /> : null;
}

export function WorkerCheckQueue() {
  const t = useTranslations('admin.checkQueue');
  const format = useFormatter();
  const fallback = useApiErrorMessage();
  const resource = useSWR('console:check-queue', checkQueueApi.status, {
    refreshInterval: (data: CheckQueueStatus | undefined) => data?.verification.state === 'pending' && (data.verification.expiresAt ?? 0) > Date.now() / 1000 ? 2000 : 60000,
    revalidateOnFocus: true, shouldRetryOnError: isRetryableApiError, errorRetryCount: 1,
  });
  const revoked = resource.error instanceof ApiError && [401, 403, 404].includes(resource.error.status);
  const data = revoked ? undefined : resource.data;
  const [busy, setBusy] = useState<'probe' | 'update' | null>(null);
  const inFlight = useRef(false);
  const [error, setError] = useState('');
  const describe = (reason: unknown) => {
    const key = reason instanceof ApiError ? `errors.${reason.code}` : '';
    return key && t.has(key) ? t(key) : fallback(reason);
  };
  const refresh = () => { void resource.mutate().catch(() => undefined); };
  const perform = async (kind: 'probe' | 'update', enabled?: boolean) => {
    if (!data?.revision || inFlight.current) return;
    inFlight.current = true; setBusy(kind); setError('');
    try {
      const response = kind === 'probe' ? await checkQueueApi.probe({ revision: data.revision }) : await checkQueueApi.update({ revision: data.revision, enabled: Boolean(enabled) });
      await resource.mutate(response, { revalidate: false });
    } catch (reason) {
      setError(describe(reason));
      refresh();
    } finally { inFlight.current = false; setBusy(null); }
  };
  const time = (value: number | null) => value === null ? '—' : format.dateTime(new Date(value * 1000), { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const pending = data?.verification.state === 'pending' && (data.verification.expiresAt ?? 0) > Date.now() / 1000;
  const state = !data || resource.error ? 'unavailable' : !data.bound ? 'unbound' : data.schema === 'missing' ? 'schemaMissing' : data.schema !== 'ready' ? 'unavailable' : data.enabled ? 'enabled'
    : data.verification.state === 'timed_out' || data.verification.state === 'pending' && !pending ? 'timedOut' : data.verification.state === 'never' && data.lastProcessedAt ? 'disabled' : data.verification.state;
  const statusTone: Tone = state === 'enabled' || state === 'passed' ? 'up' : state === 'pending' ? 'pending' : ['unavailable', 'failed', 'timedOut', 'schemaMissing'].includes(state) ? 'warn' : 'idle';
  const unavailable = !data || data.schema !== 'ready' || !data.revision;

  return <section className="mt-3 border-t border-[var(--polaris-line)] pt-5" aria-labelledby="check-queue-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h3 id="check-queue-title" className="flex flex-wrap items-center gap-2 text-small font-semibold">
          {t('title')}
          {data && !resource.error ? <StatusPill tone={statusTone} label={t(`status.${state}`)} /> : null}
        </h3>
        <p className="mt-1 max-w-prose text-small text-[var(--polaris-ink-3)]">{t('description')}</p>
      </div>
      <Button size="sm" variant="light" isLoading={resource.isValidating && !pending} onPress={refresh} startContent={<RefreshCw size={14} />}>{t('refresh')}</Button>
    </div>
    {resource.error ? <p role="alert" className="mt-3 text-small text-danger">{describe(resource.error)}</p> : null}
    {!data ? !resource.error ? <p role="status" className="mt-4 text-small text-[var(--polaris-ink-3)]">{t('loading')}</p> : null : <>
      <p role="status" className="sr-only">{t(`status.${state}`)}</p>
      {!data.bound ? <p className="mt-3 max-w-prose rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-well)] px-3.5 py-2.5 text-small text-[var(--polaris-ink-2)]">{t('bindingHint')}</p> : null}
      {data.schema === 'ready' ? <>
        <dl className="mt-4 grid grid-cols-2 overflow-hidden rounded-xl border border-[var(--polaris-line)] xl:grid-cols-4">
          {[
            ['pendingTasks', format.number(data.pendingTasks)], ['oldestPending', time(data.oldestPendingAt)],
            ['lastEnqueued', time(data.lastEnqueuedAt)], ['lastProcessed', time(data.lastProcessedAt)],
          ].map(([label, value]) => <div key={label} className="-mt-px -ml-px min-w-0 border-t border-l border-[var(--polaris-line-soft)] px-4 py-3"><dt className="text-[12px] text-[var(--polaris-ink-3)]">{t(label)}</dt><dd className="polaris-num mt-1 break-words text-[13px] font-medium text-[var(--polaris-ink)]">{value}</dd></div>)}
        </dl>
        {data.verification.processedAt ? <p className="mt-2 text-[12px] text-[var(--polaris-ink-3)]">{t('verifiedAt')}: {time(data.verification.processedAt)}</p> : null}
      </> : null}
      {data.lastError ? <p role="alert" className="mt-3 text-small text-warning-700">{t(`errors.${data.lastError.code}`)}</p> : null}
      <div aria-busy={Boolean(busy)} className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-3">
        <Button size="sm" variant="bordered" isLoading={busy === 'probe' || pending} isDisabled={Boolean(busy) || pending || unavailable || !data.bound || Boolean(resource.error)} onPress={() => void perform('probe')} startContent={busy === 'probe' || pending ? null : <SearchCheck size={15} />}>{t(pending ? 'probing' : 'probe')}</Button>
        <Switch size="sm" isSelected={data.enabled} isDisabled={Boolean(busy) || unavailable || (!data.enabled && (!data.canEnable || Boolean(resource.error)))} onValueChange={enabled => void perform('update', enabled)}>{t('enable')}</Switch>
      </div>
      {!data.enabled && data.bound && data.verification.state === 'passed' && !data.canEnable ? <p className="mt-2 text-small text-[var(--polaris-ink-3)]">{t('errors.probe_required')}</p> : null}
    </>}
    {error ? <p role="alert" className="mt-3 text-small text-danger">{error}</p> : null}
    <ul className="mt-4 flex max-w-prose flex-col gap-1 text-[12px] leading-5 text-[var(--polaris-ink-3)]">
      {data ? <li>{t('batchHint', { count: data.limits.tasksPerMessage })}</li> : null}
      <li>{t('costHint')}</li>
      <li>{t('crashHint')}</li>
    </ul>
  </section>;
}
