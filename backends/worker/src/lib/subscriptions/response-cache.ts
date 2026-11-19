import { readSubscriptionJson, type SubscriptionResponseCache } from '../../../../../shared/subscription-fetch';
import { SubscriptionError, type Subscription } from '../../../../../shared/subscriptions';
import { decryptSubscriptionSecrets, encryptSubscriptionSecrets } from './credentials';
import type { SubscriptionStore } from './store';

const encode = (value: Uint8Array) => { let text = ''; for (let offset = 0; offset < value.length; offset += 8192) text += String.fromCharCode(...value.subarray(offset, offset + 8192)); return btoa(text); };
export async function readResponseCache(store: SubscriptionStore, subscription: Subscription, material: string): Promise<Record<string, SubscriptionResponseCache>> {
  const manifest = await store.document<{ parts: number; configId: string }>('response-cache', subscription.id);
  if (!manifest || manifest.configId !== subscription.configId) return {};
  if (!Number.isInteger(manifest.parts) || manifest.parts < 1 || manifest.parts > 100) throw new SubscriptionError('subscription_cache_invalid', 503);
  const parts = await Promise.all(Array.from({ length: manifest.parts }, (_, index) => store.document<{ value: string }>('response-part', `${subscription.id}:${index}`)));
  if (parts.some(part => !part)) throw new SubscriptionError('subscription_cache_invalid', 503);
  const secret = await decryptSubscriptionSecrets(parts.map(part => part!.value).join(''), `response:${subscription.id}:${subscription.configId}`, material);
  const bytes = Uint8Array.from(atob(String(secret.value)), character => character.charCodeAt(0));
  const decompressed = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return (await readSubscriptionJson(new Response(decompressed), 11 * 1024 * 1024)).value as Record<string, SubscriptionResponseCache>;
}
export async function responseCacheWrites(store: SubscriptionStore, subscription: Subscription, cache: Record<string, SubscriptionResponseCache>, material: string) {
  const compressed = await new Response(new Blob([JSON.stringify(cache)]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer();
  const encrypted = await encryptSubscriptionSecrets({ value: encode(new Uint8Array(compressed)) }, `response:${subscription.id}:${subscription.configId}`, material);
  const writes = [], size = 262144;
  writes.push(store.write("DELETE FROM subscription_documents WHERE kind='response-part' AND subscription_id=?", [subscription.id]));
  for (let offset = 0; offset < encrypted.length; offset += size) writes.push(store.documentWrite('response-part', `${subscription.id}:${offset / size}`, { value: encrypted.slice(offset, offset + size) }, subscription.id));
  writes.push(store.documentWrite('response-cache', subscription.id, { parts: writes.length - 1, configId: subscription.configId }, subscription.id));
  return writes;
}
