import { publicSubscriptionUrl } from '../../../../../shared/subscription-fetch';
import type { Subscription } from '../../../../../shared/subscriptions';
import { fetchSiteIcon, type SiteIcon } from '../monitor/icon';
import { validateSubscriptionDestination } from './egress';
import type { SubscriptionStore } from './store';

type CachedIcon = { source: string; bytes: string | null; contentType: string | null; checkedAt: number };

export async function subscriptionIcon(store: SubscriptionStore, subscription: Subscription): Promise<SiteIcon | null> {
  let source: string;
  try { source = publicSubscriptionUrl(subscription.sourcePageUrl || `https://${subscription.sourceHosts?.[0] ?? ''}/`).origin + '/'; }
  catch { return null; }
  const now = Math.floor(Date.now() / 1000), cached = await store.document<CachedIcon>('icon', subscription.id);
  if (cached?.source === source && now - cached.checkedAt < (cached.bytes ? 604800 : 3600)) {
    return cached.bytes && cached.contentType ? { bytes: Uint8Array.from(atob(cached.bytes), c => c.charCodeAt(0)).buffer, contentType: cached.contentType } : null;
  }
  const icon = await fetchSiteIcon(new URL(source), { validateUrl: url => validateSubscriptionDestination(publicSubscriptionUrl(url.href)) });
  let encoded = '';
  if (icon) for (const byte of new Uint8Array(icon.bytes)) encoded += String.fromCharCode(byte);
  await store.putDocument('icon', subscription.id, { source, bytes: icon ? btoa(encoded) : null, contentType: icon?.contentType ?? null, checkedAt: now }, subscription.id);
  return icon;
}
