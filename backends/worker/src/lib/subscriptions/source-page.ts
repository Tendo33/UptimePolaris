import { publicSubscriptionUrl, readSubscriptionText, type SubscriptionTransport } from '../../../../../shared/subscription-fetch';
import { isKumaStatusPage } from '../../../../../shared/subscription-page';
import { subscriptionParameters } from '../../../../../shared/subscription-validation';
import { SUBSCRIPTION_LIMITS, SubscriptionError, type SubscriptionDescriptor } from '../../../../../shared/subscriptions';

export async function subscriptionPreviewParameters(descriptor: SubscriptionDescriptor, supplied: unknown, transport: SubscriptionTransport) {
  return subscriptionParameters(descriptor, await resolveSubscriptionPageParameters(descriptor, supplied, transport));
}

async function resolveSubscriptionPageParameters(descriptor: SubscriptionDescriptor, supplied: unknown, transport: SubscriptionTransport): Promise<unknown> {
  if (!isKumaStatusPage(descriptor) || !supplied || typeof supplied !== 'object' || Array.isArray(supplied)) return supplied;
  const parameters = supplied as Record<string, unknown>;
  if ((parameters.slug != null && parameters.slug !== '') || typeof parameters.baseUrl !== 'string' || !parameters.baseUrl) return supplied;
  if (parameters.baseUrl.length > 8192 || /[\u0000\r\n]/.test(parameters.baseUrl)) throw new SubscriptionError('subscription_parameters_invalid');

  let target = publicSubscriptionUrl(parameters.baseUrl);
  if (target.search) throw new SubscriptionError('subscription_parameters_invalid');
  const origin = target.origin;
  const signal = AbortSignal.timeout(SUBSCRIPTION_LIMITS.timeoutMs);
  const unresolved = () => new SubscriptionError('subscription_source_page_unresolved');
  try {
    for (let redirects = 0; ; redirects++) {
      await transport.validateUrl(target);
      transport.reserve?.();
      const response = await transport.fetch(target, { headers: { accept: 'text/html' }, redirect: 'manual', signal });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel();
        const location = response.headers.get('location');
        if (!location || redirects >= SUBSCRIPTION_LIMITS.redirects) throw unresolved();
        const next = new URL(location, target);
        next.hash = '';
        if (next.origin !== origin) throw unresolved();
        target = publicSubscriptionUrl(next);
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw unresolved(); }
      const { text } = await readSubscriptionText(response, 256 * 1024);
      let slug: string | undefined;
      await new HTMLRewriter().on('link[href]', {
        element(link) {
          if (!link.getAttribute('rel')?.toLowerCase().split(/\s+/).includes('manifest')) return;
          const match = /^\/api\/status-page\/([a-z0-9_-]+)\/manifest\.json$/i.exec(link.getAttribute('href') ?? '');
          if (match) slug ??= match[1];
        },
      }).transform(new Response(text, { headers: { 'content-type': 'text/html; charset=utf-8' } })).text();
      if (!slug) throw unresolved();
      const basePath = target.pathname.replace(/\/(?:status(?:\/[^/]+)?|status-page)\/?$/, '').replace(/\/$/, '');
      return { ...parameters, baseUrl: origin + basePath, slug };
    }
  } catch (error) {
    if (error instanceof SubscriptionError) throw error;
    throw unresolved();
  }
}
