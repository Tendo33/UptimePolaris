export const NOTIFICATION_EVENT_KINDS = ['monitor_state', 'ai_state', 'agent_resource', 'subscription_sync'] as const;
export type NotificationEventKind = typeof NOTIFICATION_EVENT_KINDS[number];
export interface NotificationRoutingScope {
  id: string;
  active?: number | boolean;
  group_ids: string[];
  event_kinds?: NotificationEventKind[];
  source_types?: ('local' | 'subscription')[];
}
export interface NotificationRoutingEvent {
  notificationEnabled?: boolean;
  notificationChannelIds?: string[];
  groupId?: string | null;
  eventKind?: NotificationEventKind;
  sourceType?: 'local' | 'subscription';
  aiChannelId?: string;
  aiModelId?: string;
  subscriptionId?: string;
  monitorType?: string;
  eventKey?: string;
}
export function notificationRoutingReason(channel: NotificationRoutingScope, event: NotificationRoutingEvent): string | null {
  if (event.notificationEnabled === false) return 'notifications_disabled';
  if (channel.active !== undefined && !channel.active) return 'channel_inactive';
  if (event.notificationChannelIds?.length) return event.notificationChannelIds.includes(channel.id) ? null : 'channel_not_selected';
  const kind = event.eventKind ?? (event.aiModelId || event.monitorType === 'ai' ? 'ai_state' : event.eventKey?.startsWith('resource:') ? 'agent_resource' : 'monitor_state');
  const source = event.sourceType ?? (event.subscriptionId ? 'subscription' : 'local');
  if (!(channel.event_kinds ?? ['monitor_state', 'ai_state', 'agent_resource']).includes(kind)) return 'event_outside_scope';
  if (!(channel.source_types ?? ['local']).includes(source)) return 'source_outside_scope';
  if (channel.group_ids.length && (!event.groupId || !channel.group_ids.includes(event.groupId))) return 'group_outside_scope';
  return null;
}

export function monitorNotificationEnabled(optionsJson: string): boolean {
  return JSON.parse(optionsJson).notificationEnabled !== false;
}
