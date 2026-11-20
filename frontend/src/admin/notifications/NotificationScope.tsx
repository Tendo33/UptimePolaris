import { requestJson } from '@/api/client';
import { Select } from '@/components/ui/MotionOverlays';
import { Button, SelectItem } from '@heroui/react';
import clsx from 'clsx';
import { Check } from 'lucide-react';
import useSWR from 'swr';
import { useTranslations } from 'use-intl';
import { NOTIFICATION_EVENT_KINDS, type NotificationRoutingScope } from '../../../../shared/notification-policy';
import { usePresentation } from '../settings/presentation-api';
import { subscriptionsApi } from '../subscriptions/api';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';

export type ChannelScope = Pick<NotificationRoutingScope, 'event_kinds' | 'source_types' | 'ai_channel_ids' | 'subscription_ids'>;
export const defaultChannelScope = (): ChannelScope => ({ event_kinds: ['monitor_state', 'ai_state', 'agent_resource'], source_types: ['local'], ai_channel_ids: [], subscription_ids: [] });

/** Toggle chips for a small fixed set of values. / 用于少量固定选项的切换标签。 */
function ChipSet<T extends string>({ label, values, value, onChange, text, disabled }: { label: string; values: readonly T[]; value: T[]; onChange: (next: T[]) => void; text: (value: T) => string; disabled?: boolean }) {
  return (
    <div>
      <p className="mb-2 text-[12.5px] font-medium text-[var(--polaris-ink-2)]">{label}</p>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {values.map(option => {
          const on = value.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onChange(on ? value.filter(item => item !== option) : [...value, option])}
              className={clsx(
                'inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50',
                on ? 'border-[var(--polaris-ink)] bg-[var(--polaris-ink)] text-[var(--polaris-card)]' : 'border-[var(--polaris-line)] text-[var(--polaris-ink-2)] hover:bg-[var(--polaris-hover)]',
              )}
            >
              {on ? <Check size={13} strokeWidth={2.5} aria-hidden="true" /> : null}
              {text(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function NotificationScope({ value, onChange, disabled }: { value: ChannelScope; onChange: (scope: ChannelScope) => void; disabled?: boolean }) {
  const t = useTranslations('admin.notificationPolicy');
  const describe = useApiErrorMessage();
  const enabled = usePresentation().data?.config.aiEnabled === true;
  const channels = useSWR(enabled ? 'console:notification-ai-scopes' : null, () => requestJson<{ channels: { id: string; name: string }[] }>('/api/admin/ai/channels'), { shouldRetryOnError: false });
  const subscriptions = useSWR(value.source_types?.includes('subscription') ? 'console:notification-subscription-scopes' : null, () => subscriptionsApi.all('archived=true'), { shouldRetryOnError: false });
  const options = (rows: { id: string; name: string }[], ids: string[]) => [...rows, ...ids.filter(id => !rows.some(row => row.id === id)).map(id => ({ id, name: `${t('missing')} (${id})` }))];
  const empty = !value.event_kinds?.length || !value.source_types?.length;

  return (
    <section className="space-y-4 rounded-xl border border-[var(--polaris-line)] p-4">
      <div>
        <h3 className="text-[13.5px] font-semibold text-[var(--polaris-ink)]">{t('scope')}</h3>
        <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">{t('scopeHint')}</p>
      </div>
      <ChipSet label={t('eventKinds')} values={NOTIFICATION_EVENT_KINDS} value={(value.event_kinds ?? []) as (typeof NOTIFICATION_EVENT_KINDS)[number][]} disabled={disabled} text={kind => t(`events.${kind}`)} onChange={next => onChange({ ...value, event_kinds: next as ChannelScope['event_kinds'] })} />
      <ChipSet label={t('sources')} values={['local', 'subscription'] as const} value={(value.source_types ?? []) as ('local' | 'subscription')[]} disabled={disabled} text={kind => t(`sourcesValue.${kind}`)} onChange={next => onChange({ ...value, source_types: next as ChannelScope['source_types'] })} />
      {empty ? <p role="status" className="text-[12px] text-warning-700">{t('emptyScope')}</p> : null}
      {channels.error || subscriptions.error ? <div role="alert" className="flex items-center gap-2 text-[12px] text-danger-600"><span>{describe(channels.error || subscriptions.error)}</span><Button size="sm" variant="light" onPress={() => { void channels.mutate(); void subscriptions.mutate(); }}>{t('retry')}</Button></div> : null}
      {enabled || value.source_types?.includes('subscription') ? (
        <div className="grid gap-4 sm:grid-cols-2">
          {enabled ? (
            <Select label={t('aiChannels')} labelPlacement="outside" placeholder={t('unrestrictedShort')} description={t('unrestricted')} selectionMode="multiple" selectedKeys={value.ai_channel_ids ?? []} isDisabled={disabled || !channels.data} onSelectionChange={keys => { if (keys !== 'all') onChange({ ...value, ai_channel_ids: [...keys].map(String) }); }}>
              {options(channels.data?.channels ?? [], value.ai_channel_ids ?? []).map(row => <SelectItem key={row.id}>{row.name}</SelectItem>)}
            </Select>
          ) : null}
          {value.source_types?.includes('subscription') ? (
            <Select label={t('subscriptions')} labelPlacement="outside" placeholder={t('unrestrictedShort')} description={t('unrestricted')} selectionMode="multiple" selectedKeys={value.subscription_ids ?? []} isDisabled={disabled || !subscriptions.data} onSelectionChange={keys => { if (keys !== 'all') onChange({ ...value, subscription_ids: [...keys].map(String) }); }}>
              {options(subscriptions.data?.items ?? [], value.subscription_ids ?? []).map(row => <SelectItem key={row.id}>{row.name}</SelectItem>)}
            </Select>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
