import { publicSubscriptionUrl, readSubscriptionJson } from '../../../../../shared/subscription-fetch';
import { SubscriptionError } from '../../../../../shared/subscriptions';

export function publicSubscriptionAddress(value: string): boolean {
  const ipv4 = value.split('.').map(Number);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(value)) {
    if (ipv4.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return false;
    const [a, b, c] = ipv4;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 || b === 2) || a === 100 && b >= 64 && b <= 127 || a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113);
  }
  if (!/^[0-9a-f:]+$/i.test(value)) return false;
  let normalized: string;
  try { normalized = new URL(`https://[${value}]/`).hostname.slice(1, -1).toLowerCase(); } catch { return false; }
  return /^[23][0-9a-f]{3}:/.test(normalized) && !/^2001:(:|db8:|0:|2:|10:|20:)/.test(normalized) && !normalized.startsWith('2002:');
}

export async function validateSubscriptionDestination(url: URL, reserve?: () => void, transport: typeof fetch = fetch): Promise<void> {
  publicSubscriptionUrl(url);
  let addresses = 0;
  for (const type of ['A', 'AAAA']) {
    reserve?.();
    const resolver = new URL('https://cloudflare-dns.com/dns-query');
    resolver.searchParams.set('name', url.hostname); resolver.searchParams.set('type', type);
    const response = await transport(resolver, { headers: { accept: 'application/dns-json' }, redirect: 'manual', signal: AbortSignal.timeout(5000) });
    if (!response.ok) { await response.body?.cancel(); throw new SubscriptionError('subscription_fetch_failed', 502); }
    const result = (await readSubscriptionJson(response, 65536)).value as { Status?: number; Answer?: { type: number; data: string }[] };
    if (result.Status !== 0 || result.Answer !== undefined && !Array.isArray(result.Answer)) throw new SubscriptionError('subscription_fetch_failed', 502);
    for (const answer of result.Answer ?? []) if ([1, 28].includes(answer.type)) {
      if (typeof answer.data !== 'string' || !publicSubscriptionAddress(answer.data)) throw new SubscriptionError('subscription_source_blocked');
      addresses++;
    }
  }
  if (!addresses) throw new SubscriptionError('subscription_fetch_failed', 502);
}
