import { SubscriptionError } from '../../../../../shared/subscriptions';

const domain = 'uptime-polaris-subscription-secrets-v1';
const encoder = new TextEncoder();
const encode = (value: Uint8Array) => btoa(Array.from(value, byte => String.fromCharCode(byte)).join(''));
const decode = (value: string) => Uint8Array.from(atob(value), character => character.charCodeAt(0));

async function key(material: string): Promise<CryptoKey> {
  if (!material) throw new SubscriptionError('subscription_key_unavailable', 503);
  const base = await crypto.subtle.importKey('raw', encoder.encode(material), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(domain), info: encoder.encode('parameters') }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
export async function encryptSubscriptionSecrets(value: Record<string, string | number | boolean>, id: string, material: string): Promise<string> {
  if (!Object.keys(value).length) return '';
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: encoder.encode(`${domain}:${id}`) }, await key(material), encoder.encode(JSON.stringify(value)));
  return `v1.${encode(nonce)}.${encode(new Uint8Array(ciphertext))}`;
}
export async function decryptSubscriptionSecrets(value: string, id: string, material: string): Promise<Record<string, string | number | boolean>> {
  if (!value) return {};
  try {
    const [version, nonce, ciphertext, extra] = value.split('.');
    if (version !== 'v1' || !nonce || !ciphertext || extra) throw new Error();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: decode(nonce), additionalData: encoder.encode(`${domain}:${id}`) }, await key(material), decode(ciphertext));
    return JSON.parse(new TextDecoder().decode(plain));
  } catch { throw new SubscriptionError('subscription_credential_unavailable', 503); }
}
