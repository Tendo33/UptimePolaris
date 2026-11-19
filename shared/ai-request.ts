export interface AiRequestOptions {
  prompt: string;
  maxOutputTokens: number;
  expectedText: string;
  body?: Record<string, unknown>;
}

export const DEFAULT_AI_REQUEST: AiRequestOptions = { prompt: 'Reply OK.', maxOutputTokens: 64, expectedText: '' };
const reservedHeaders = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'anthropic-version', 'content-type', 'host', 'content-length', 'connection', 'transfer-encoding', 'upgrade', 'cookie', 'set-cookie', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'keep-alive']);

export function parseAiHeaders(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const entries = Object.entries(value);
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536) return null;
  const result: Record<string, string> = {};
  for (const [name, content] of entries) {
    const key = name.toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9a-z-]{1,64}$/.test(key) || reservedHeaders.has(key) || key.startsWith('sec-') ||
        typeof content !== 'string' || content.length > 2048 || /[^\x20-\x7e]/.test(content) || Object.hasOwn(result, key)) return null;
    Object.defineProperty(result, key, { value: content, enumerable: true, writable: true, configurable: true });
  }
  return result;
}

export function parseAiRequest(value: unknown): AiRequestOptions | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !['prompt', 'maxOutputTokens', 'expectedText', 'body'].includes(key)) ||
      typeof input.prompt !== 'string' || !input.prompt.trim() || [...input.prompt].length > 2000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.prompt) ||
      !Number.isInteger(input.maxOutputTokens) || Number(input.maxOutputTokens) < 1 || Number(input.maxOutputTokens) > 4096 ||
      typeof input.expectedText !== 'string' || [...input.expectedText].length > 200 || /[\u0000-\u001f\u007f]/.test(input.expectedText)) return null;
  const body = input.body === undefined ? {} : parseAiBody(input.body);
  if (!body) return null;
  return { prompt: input.prompt, maxOutputTokens: Number(input.maxOutputTokens), expectedText: input.expectedText, ...(Object.keys(body).length ? { body } : {}) };
}

export function parseAiBody(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    if (new TextEncoder().encode(JSON.stringify(value)).byteLength > 65536) return null;
    const pending = [{ value, depth: 0 }];
    while (pending.length) {
      const item = pending.pop()!;
      if (item.depth > 32) return null;
      if (item.value && typeof item.value === 'object') {
        for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
      }
    }
    return value as Record<string, unknown>;
  } catch { return null; }
}

export function mergeAiBody(base: Record<string, unknown>, overrides: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries([...new Set([...Object.keys(base), ...Object.keys(overrides)])].map(key => {
    const left = base[key], right = overrides[key];
    return [key, !Object.hasOwn(overrides, key) ? left : left && right && typeof left === 'object' && typeof right === 'object' && !Array.isArray(left) && !Array.isArray(right)
      ? mergeAiBody(left as Record<string, unknown>, right as Record<string, unknown>) : right];
  }));
}
