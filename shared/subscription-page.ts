import type { SubscriptionDescriptor } from './subscriptions';

export function isKumaStatusPage(descriptor: SubscriptionDescriptor): boolean {
  return descriptor.id === 'uptime-kuma' &&
    descriptor.sourcePage?.baseUrlInput === 'baseUrl' && descriptor.sourcePage.path === '/status/{slug}' &&
    descriptor.inputs.baseUrl?.type === 'url' && descriptor.inputs.slug?.type === 'string' &&
    descriptor.inputs.slug.required === true && descriptor.inputs.slug.default === undefined;
}
