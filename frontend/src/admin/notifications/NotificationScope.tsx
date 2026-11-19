import { requestJson } from '@/api/client';
import { Select } from '@/components/ui/MotionOverlays';
import { SelectItem } from '@heroui/react';
import useSWR from 'swr';
import { useTranslations } from 'use-intl';
import { NOTIFICATION_EVENT_KINDS, type NotificationRoutingScope } from '../../../../shared/notification-policy';
import { usePresentation } from '../settings/presentation-api';
import { subscriptionsApi } from '../subscriptions/api';

export type ChannelScope = Pick<NotificationRoutingScope, 'event_kinds' | 'source_types' | 'ai_channel_ids' | 'subscription_ids'>;
export const defaultChannelScope = (): ChannelScope => ({ event_kinds: ['monitor_state', 'ai_state', 'agent_resource'], source_types: ['local'], ai_channel_ids: [], subscription_ids: [] });

export function NotificationScope({ value, onChange, disabled }: { value: ChannelScope; onChange: (scope: ChannelScope) => void; disabled?: boolean }) {
  const t = useTranslations('admin.notificationPolicy');
  const enabled = usePresentation().data?.config.aiEnabled === true;
  const channels = useSWR(enabled ? 'console:notification-ai-scopes' : null, () => requestJson<{ channels: { id: string; name: string }[] }>('/api/admin/ai/channels'), { shouldRetryOnError: false });
  const subscriptions = useSWR('console:notification-subscription-scopes', async () => { const items: { id: string; name: string }[] = []; let offset: number | null = 0; do { const page = await subscriptionsApi.list(`archived=true&limit=200&offset=${offset}`); items.push(...page.items); offset = page.nextOffset; } while (offset !== null); return { items }; }, { shouldRetryOnError: false });
  const options = (rows: { id: string; name: string }[], ids: string[]) => [...rows, ...ids.filter(id => !rows.some(row => row.id === id)).map(id => ({ id, name: `${t('missing')} (${id})` }))];
  return <section className="space-y-4">
    <h3 className="text-medium font-semibold">{t('scope')}</h3>
    <Select label={t('eventKinds')} selectionMode="multiple" selectedKeys={value.event_kinds ?? []} isDisabled={disabled} onSelectionChange={keys => onChange({ ...value, event_kinds: keys === 'all' ? [...NOTIFICATION_EVENT_KINDS] : [...keys].map(String) as ChannelScope['event_kinds'] })}>{NOTIFICATION_EVENT_KINDS.map(kind => <SelectItem key={kind}>{t(`events.${kind}`)}</SelectItem>)}</Select>
    <Select label={t('sources')} selectionMode="multiple" selectedKeys={value.source_types ?? []} isDisabled={disabled} onSelectionChange={keys => onChange({ ...value, source_types: keys === 'all' ? ['local', 'subscription'] : [...keys].map(String) as ChannelScope['source_types'] })}>{(['local', 'subscription'] as const).map(kind => <SelectItem key={kind}>{t(`sourcesValue.${kind}`)}</SelectItem>)}</Select>
    {!value.event_kinds?.length || !value.source_types?.length ? <p role="status" className="text-small text-warning">{t('emptyScope')}</p> : null}
    {enabled ? <Select label={t('aiChannels')} description={t('unrestricted')} selectionMode="multiple" selectedKeys={value.ai_channel_ids ?? []} isDisabled={disabled || !channels.data} onSelectionChange={keys => { if (keys !== 'all') onChange({ ...value, ai_channel_ids: [...keys].map(String) }); }}>{options(channels.data?.channels ?? [], value.ai_channel_ids ?? []).map(row => <SelectItem key={row.id}>{row.name}</SelectItem>)}</Select> : null}
    {value.source_types?.includes('subscription') ? <Select label={t('subscriptions')} description={t('unrestricted')} selectionMode="multiple" selectedKeys={value.subscription_ids ?? []} isDisabled={disabled || !subscriptions.data} onSelectionChange={keys => { if (keys !== 'all') onChange({ ...value, subscription_ids: [...keys].map(String) }); }}>{options(subscriptions.data?.items ?? [], value.subscription_ids ?? []).map(row => <SelectItem key={row.id}>{row.name}</SelectItem>)}</Select> : null}
  </section>;
}
