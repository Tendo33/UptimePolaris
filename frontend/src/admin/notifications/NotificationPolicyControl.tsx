import { requestJson } from '@/api/client';
import { Select } from '@/components/ui/MotionOverlays';
import { Button, SelectItem } from '@heroui/react';
import clsx from 'clsx';
import { AlertCircle, BellOff, BellRing, ChevronRight, Globe, ListChecks, Pause, RotateCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'use-intl';
import type { NotificationRoutingEvent } from '../../../../shared/notification-policy';
import { notificationsApi } from './api';

const MODES = [
  { value: 'global', icon: Globe },
  { value: 'custom', icon: ListChecks },
  { value: 'off', icon: BellOff },
] as const;

export function NotificationPolicyControl({ enabled, ids, onChange, context, disabled, onValidityChange }: { enabled: boolean; ids: string[]; onChange: (enabled: boolean, ids: string[]) => void; context: NotificationRoutingEvent; disabled?: boolean; onValidityChange?: (valid: boolean) => void }) {
  const t = useTranslations('admin.notificationPolicy');
  const [custom, setCustom] = useState(false);
  const mode = !enabled ? 'off' : ids.length || custom ? 'custom' : 'global';
  useEffect(() => { onValidityChange?.(mode !== 'custom' || ids.length > 0); }, [mode, ids.length, onValidityChange]);
  const event = { ...context, notificationEnabled: enabled && (mode !== 'custom' || ids.length > 0), notificationChannelIds: ids };
  const signature = JSON.stringify(event);
  const preview = useSWR(['console:notification-policy', signature], () => requestJson<{ channels: { id: string; name: string; reason: string | null }[]; suppressed: boolean }>('/api/notifications/resolve', { method: 'POST', body: signature }), { revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 2000 });
  const selected = preview.data?.channels.filter(channel => !channel.reason) ?? [];
  const excluded = preview.data?.channels.filter(channel => channel.reason) ?? [];
  const channels = useSWR(mode === 'custom' ? 'console:notification-picker' : null, notificationsApi.listNotifications, { shouldRetryOnError: false, revalidateOnFocus: false });
  const choices = [...(channels.data?.channels ?? []).map(channel => ({ id: channel.id, name: channel.name, active: channel.active })), ...ids.filter(id => !channels.data?.channels.some(channel => channel.id === id)).map(id => ({ id, name: `${t('missing')} (${id})`, active: 0 }))];
  const choose = (value: string) => { setCustom(value === 'custom'); onChange(value !== 'off', value === 'global' ? [] : ids); };

  return (
    <div className="@container space-y-3">
      <div role="radiogroup" aria-label={t('mode')} className="grid gap-2 @lg:grid-cols-3">
        {MODES.map(({ value, icon: Icon }) => {
          const on = mode === value;
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled}
              onClick={() => choose(value)}
              className={clsx(
                'flex items-start gap-2.5 rounded-xl border px-3 py-2.5 text-left transition-[border-color,background-color,box-shadow] disabled:opacity-60',
                on ? 'border-[var(--polaris-ink)] bg-[var(--polaris-hover)] shadow-[0_0_0_1px_var(--polaris-ink)]' : 'border-[var(--polaris-line)] hover:border-[var(--polaris-ink-4)] hover:bg-[var(--polaris-hover)]',
              )}
            >
              <Icon size={15} className={clsx('mt-0.5 shrink-0', on ? 'text-[var(--polaris-ink)]' : 'text-[var(--polaris-ink-4)]')} aria-hidden="true" />
              <span className="min-w-0">
                <span className="block text-[13px] font-medium text-[var(--polaris-ink)]">{t(value)}</span>
                <span className="mt-0.5 block text-[11.5px] leading-snug text-[var(--polaris-ink-3)]">{t(`${value}Hint`)}</span>
              </span>
            </button>
          );
        })}
      </div>

      {mode === 'custom' ? (
        <div className="space-y-1.5">
          {channels.error ? <Button size="sm" variant="light" onPress={() => void channels.mutate()}>{t('retry')}</Button> : null}
          <Select label={t('custom')} labelPlacement="outside" placeholder={t('chooseChannel')} selectionMode="multiple" selectedKeys={ids} isLoading={channels.isLoading} isDisabled={disabled || !channels.data} onSelectionChange={keys => { if (keys !== 'all') onChange(true, [...keys].map(String)); }}>
            {choices.map(channel => <SelectItem key={channel.id} textValue={channel.name}>{channel.name}{!channel.active ? ` · ${t('reasons.channel_inactive')}` : ''}</SelectItem>)}
          </Select>
          {!ids.length ? <p role="alert" className="text-[12px] text-warning-700">{t('chooseChannel')}</p> : null}
        </div>
      ) : null}

      <div aria-live="polite" className="rounded-xl bg-[var(--polaris-well)] px-3.5 py-3 text-[12.5px]">
        <p className="mb-1.5 text-[11.5px] font-medium tracking-wide text-[var(--polaris-ink-4)] uppercase">{t('previewTitle')}</p>
        {preview.error ? (
          <Button size="sm" variant="light" className="-ml-2" startContent={<RotateCw size={13} />} onPress={() => void preview.mutate()}>{t('retry')}</Button>
        ) : preview.isLoading ? (
          <span className="polaris-shimmer block h-5 w-40 rounded-md" aria-label={t('resolving')} />
        ) : preview.data?.suppressed ? (
          <p className="flex items-center gap-1.5 text-warning-700"><Pause size={13} />{t('suppressed')}</p>
        ) : selected.length ? (
          <ul className="flex flex-wrap gap-1.5">
            {selected.map(channel => (
              <li key={channel.id} className="inline-flex h-6 items-center gap-1.5 rounded-md border border-[var(--polaris-line)] bg-[var(--polaris-card)] px-2 text-[12px] text-[var(--polaris-ink)]">
                <BellRing size={11} className="text-success-600" aria-hidden="true" />
                {channel.name}
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-1.5 text-[var(--polaris-ink-3)]"><AlertCircle size={13} />{t('noReceivers')}</p>
        )}
        {excluded.length ? (
          <details className="group mt-2">
            <summary className="flex cursor-pointer list-none items-center gap-1 text-[12px] text-[var(--polaris-ink-3)] hover:text-[var(--polaris-ink)] [&::-webkit-details-marker]:hidden">
              <ChevronRight size={13} className="transition-transform group-open:rotate-90" aria-hidden="true" />
              {t('excluded')} · {excluded.length}
            </summary>
            <ul className="mt-1.5 space-y-1 pl-4">
              {excluded.map(channel => (
                <li key={channel.id} className="flex flex-wrap gap-x-2 text-[12px]">
                  <span className="text-[var(--polaris-ink-2)]">{channel.name}</span>
                  <span className="text-[var(--polaris-ink-4)]">{t.has(`reasons.${channel.reason}`) ? t(`reasons.${channel.reason}`) : channel.reason}</span>
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </div>
    </div>
  );
}
