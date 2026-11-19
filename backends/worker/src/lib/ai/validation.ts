import type { AiChannelInput, AiManagementError, AiModelValues } from '../../../../../shared/ai-management';
import { parseAiHeaders, parseAiRequest, DEFAULT_AI_REQUEST } from '../../../../../shared/ai-request';
import { isAiProtocol } from '../../../../../shared/ai-probe';
import { notificationChannelIds } from '../../../../../shared/notification-routing';

export class AiError extends Error {
  constructor(readonly code: AiManagementError, readonly status: 400 | 404 | 409 | 502 | 503 = 400) { super(code); }
}

export function aiBaseUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048 || /[\s\\\u0000-\u001f\u007f]/.test(value)) throw new AiError('invalid_ai_url');
  let url: URL;
  try { url = new URL(value); } catch { throw new AiError('invalid_ai_url'); }
  let host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  const mapped = /^::ffff:([0-9a-f]+):([0-9a-f]+)$/.exec(host);
  if (mapped) {
    const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
    host = `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  const authority = value.split('/')[2] ?? '';
  if (!mapped && /^\d+\.\d+\.\d+\.\d+$/.test(host) && authority.split(':')[0] !== host) throw new AiError('invalid_ai_url');
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || value.includes('?') || value.includes('#') ||
      url.port !== '' && Number(url.port) === 0 || /[^\x00-\x7f]/.test(value.split('/')[2] ?? '') ||
      ['metadata.google.internal', 'metadata.goog', 'metadata.internal', 'instance-data.ec2.internal', '100.100.100.200', 'fd00:ec2::254', '::'].includes(host) ||
      /^(?:0\.|169\.254\.|(?:22[4-9]|23\d|24\d|25[0-5])\.)/.test(host) || /^fe[89ab][0-9a-f]:/i.test(host) || /^ff[0-9a-f]{2}:/i.test(host) ||
      host.endsWith('.test') || host.endsWith('.invalid') ||
      /^(?:192\.0\.(?:0|2)\.|198\.(?:18|19)\.|198\.51\.100\.|203\.0\.113\.)/.test(host) ||
      host.startsWith('2001:db8:') ||
      /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(value.slice(value.indexOf('://') + 3))) throw new AiError('invalid_ai_url');
  return url;
}

export function aiObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AiError('invalid_request');
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || !value.trim() || [...value.trim()].length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new AiError('invalid_request');
  return value.trim();
}

export function aiRevision(value: unknown): string { return text(value, 64); }

export function channelInput(body: Record<string, unknown>, create: boolean): AiChannelInput {
  const name = text(body.name, 120);
  aiBaseUrl(body.baseUrl);
  if (!isAiProtocol(body.protocol)) throw new AiError('invalid_request');
  if (create && body.apiKey === undefined) throw new AiError('api_key_required');
  let apiKey: string | undefined;
  if (body.apiKey !== undefined) {
    if (typeof body.apiKey !== 'string' || !body.apiKey.trim() || body.apiKey.length > 4096 || /[^\x21-\x7e]/.test(body.apiKey)) throw new AiError('invalid_request');
    apiKey = body.apiKey;
  }
  const headers = body.headers === undefined ? undefined : parseAiHeaders(body.headers);
  if (headers === null) throw new AiError('invalid_ai_headers');
  const ids = body.notificationChannelIds === undefined ? undefined : notificationChannelIds(body.notificationChannelIds);
  if (ids === null) throw new AiError('invalid_request');
  if (body.notificationEnabled !== undefined && typeof body.notificationEnabled !== 'boolean') throw new AiError('invalid_request');
  return { name, baseUrl: body.baseUrl as string, protocol: body.protocol, ...(apiKey === undefined ? {} : { apiKey }), ...(headers === undefined ? {} : { headers }), ...(ids === undefined ? {} : { notificationChannelIds: ids }), ...(body.notificationEnabled === undefined ? {} : { notificationEnabled: body.notificationEnabled as boolean }) };
}

export function modelInput(body: Record<string, unknown>, create: boolean): AiModelValues {
  const channelId = text(body.channelId, 64), name = text(body.name, 120), modelId = text(body.modelId, 200);
  const intervalSec = create && body.intervalSec === undefined ? 300 : body.intervalSec;
  const timeoutMs = create && body.timeoutMs === undefined ? 30000 : body.timeoutMs;
  const enabled = create && body.enabled === undefined ? true : body.enabled;
  const isPublic = create && body.isPublic === undefined ? false : body.isPublic;
  if (!Number.isInteger(intervalSec) || (intervalSec as number) < 60 || (intervalSec as number) > 86400 ||
      !Number.isInteger(timeoutMs) || (timeoutMs as number) < 1000 || (timeoutMs as number) > 60000 ||
      (timeoutMs as number) >= (intervalSec as number) * 1000 || typeof enabled !== 'boolean' || typeof isPublic !== 'boolean') throw new AiError('invalid_request');
  const request = body.request === undefined ? create ? DEFAULT_AI_REQUEST : undefined : parseAiRequest(body.request);
  if (request === null) throw new AiError('invalid_ai_request');
  return { channelId, name, modelId, intervalSec: intervalSec as number, timeoutMs: timeoutMs as number, enabled, isPublic,
    ...(request === undefined ? {} : { request }) };
}
