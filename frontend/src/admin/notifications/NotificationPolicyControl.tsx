import { requestJson } from '@/api/client';
import { Button, Radio, RadioGroup, SelectItem } from '@heroui/react';
import { Select } from '@/components/ui/MotionOverlays';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'use-intl';
import type { NotificationRoutingEvent } from '../../../../shared/notification-policy';
import { notificationsApi } from './api';

export function NotificationPolicyControl({ enabled, ids, onChange, context, disabled, onValidityChange }: { enabled: boolean; ids: string[]; onChange: (enabled: boolean, ids: string[]) => void; context: NotificationRoutingEvent; disabled?: boolean; onValidityChange?: (valid: boolean) => void }) {
  const t = useTranslations('admin.notificationPolicy');
  const [custom, setCustom] = useState(false);
  const mode = !enabled ? 'off' : ids.length || custom ? 'custom' : 'global';
  useEffect(() => { onValidityChange?.(mode !== 'custom' || ids.length > 0); }, [mode, ids.length, onValidityChange]);
  const event = { ...context, notificationEnabled: enabled, notificationChannelIds: ids };
  const signature = JSON.stringify(event);
  const preview = useSWR(['console:notification-policy', signature], () => requestJson<{ channels: { id: string; name: string; reason: string | null }[]; suppressed: boolean }>('/api/notifications/resolve', { method: 'POST', body: signature }), { revalidateOnFocus: false, shouldRetryOnError: false, dedupingInterval: 2000 });
  const selected = preview.data?.channels.filter(channel => !channel.reason) ?? [];
  const channels = useSWR(mode === 'custom' ? 'console:notification-picker' : null, notificationsApi.listNotifications, { shouldRetryOnError: false, revalidateOnFocus: false });
  const choices = [...(channels.data?.channels ?? []).map(channel => ({ id: channel.id, name: channel.name, active: channel.active })), ...ids.filter(id => !channels.data?.channels.some(channel => channel.id === id)).map(id => ({ id, name: `${t('missing')} (${id})`, active: 0 }))];
  return <div className="space-y-3">
    <RadioGroup label={t('mode')} orientation="horizontal" value={mode} isDisabled={disabled} onValueChange={value => { setCustom(value === 'custom'); onChange(value !== 'off', value === 'global' ? [] : ids); }}>{['global', 'custom', 'off'].map(value => <Radio key={value} value={value}>{t(value)}</Radio>)}</RadioGroup>
    {mode === 'custom' ? <><Select label={t('custom')} selectionMode="multiple" selectedKeys={ids} isLoading={channels.isLoading} isDisabled={disabled || !channels.data} onSelectionChange={keys => { if (keys !== 'all') onChange(true, [...keys].map(String)); }}>{choices.map(channel => <SelectItem key={channel.id}>{channel.name}{!channel.active ? ` · ${t('reasons.channel_inactive')}` : ''}</SelectItem>)}</Select>{!ids.length ? <p role="alert" className="text-small text-warning">{t('chooseChannel')}</p> : null}</> : null}
    <div aria-live="polite" className="text-small text-default-500">
      {preview.error ? <Button size="sm" variant="light" onPress={() => void preview.mutate()}>{t('retry')}</Button> : preview.isLoading ? t('resolving') : preview.data?.suppressed ? t('suppressed') : selected.length ? t('receivers', { names: selected.map(channel => channel.name).join('、') }) : t('noReceivers')}
      {preview.data?.channels.some(channel => channel.reason) ? <details className="mt-2"><summary className="cursor-pointer">{t('excluded')}</summary><ul className="mt-2 space-y-1">{preview.data.channels.filter(channel => channel.reason).map(channel => <li key={channel.id}>{channel.name} · {t.has(`reasons.${channel.reason}`) ? t(`reasons.${channel.reason}`) : channel.reason}</li>)}</ul></details> : null}
    </div>
  </div>;
}
