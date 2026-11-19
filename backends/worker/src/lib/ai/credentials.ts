import { AiError } from './validation';
import { parseAiHeaders } from '../../../../../shared/ai-request';

const encoder = new TextEncoder();
const domain = 'uptime-polaris-ai-credentials-v1';
const base64 = (bytes: Uint8Array) => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(''));
const unbase64 = (value: string) => Uint8Array.from(atob(value), char => char.charCodeAt(0));

async function key(material: string): Promise<CryptoKey> {
  if (!material) throw new AiError('ai_key_material_unavailable', 503);
  const input = await crypto.subtle.importKey('raw', encoder.encode(material), 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(domain), info: encoder.encode('channel-api-key') },
    input, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
  );
}

export async function encryptAiCredential(value: string, channelId: string, material: string): Promise<string> {
  const encryptionKey = await key(material), iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: encoder.encode(`${domain}:${channelId}`) }, encryptionKey, encoder.encode(value));
  return `v1.${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
}

export async function decryptAiCredential(value: string, channelId: string, material: string): Promise<string> {
  const encryptionKey = await key(material);
  try {
    const [version, nonce, encrypted, extra] = value.split('.');
    if (version !== 'v1' || !nonce || !encrypted || extra !== undefined) throw new Error();
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unbase64(nonce), additionalData: encoder.encode(`${domain}:${channelId}`) }, encryptionKey, unbase64(encrypted));
    return new TextDecoder().decode(plain);
  } catch { throw new AiError('ai_credential_decryption_failed', 503); }
}

export async function decryptAiHeaders(value: string, channelId: string, material: string): Promise<Record<string, string>> {
  if (!value) return {};
  try {
    const headers = parseAiHeaders(JSON.parse(await decryptAiCredential(value, `${channelId}:headers`, material)));
    if (headers) return headers;
  } catch {}
  throw new AiError('ai_credential_decryption_failed', 503);
}
