import type { SubscriptionDescriptor } from '../../../../shared/subscriptions';

export function parseSubscriptionLink(value: string): URL | undefined {
  const address = value.trim();
  if (!address) return;
  try {
    const url = new URL(address.includes('://') ? address : 'https://' + address);
    if (url.protocol === 'https:' && !url.username && !url.password) return url;
  } catch {
    return;
  }
}

export function subscriptionBaseFromLink(descriptor: SubscriptionDescriptor, name: string, url: URL): string {
  const path = url.pathname.replace(/\/$/, '');
  const paths = Object.values(descriptor.requests)
    .filter(request => request.baseUrlInput === name && request.method === 'GET')
    .map(request => request.path.split('?')[0]);
  if (descriptor.sourcePage?.baseUrlInput === name) paths.push(descriptor.sourcePage.path);

  let suffix = '';
  for (const candidate of paths) {
    const fixedPath = candidate.replace(/\/$/, '');
    if (fixedPath.length > suffix.length && !/[{}]/.test(fixedPath) && path.endsWith(fixedPath)) suffix = fixedPath;
  }
  return url.origin + path.slice(0, path.length - suffix.length).replace(/\/$/, '');
}
