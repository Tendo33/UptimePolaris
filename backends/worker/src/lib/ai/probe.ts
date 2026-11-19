import { classifyAiResponse, isAiProtocol, validAiModelId, type AiProbeOutcome, type AiProtocol } from '../../../../../shared/ai-probe';
import { ExternalBudgetExceeded, isWorkerCapacityError, type ExternalRequestBudget } from '../http/request-budget';
import { isTimeoutAbort, readCapped } from '../util';
import { aiBaseUrl } from './validation';
import { DEFAULT_AI_REQUEST, mergeAiBody, parseAiHeaders, parseAiRequest, type AiRequestOptions } from '../../../../../shared/ai-request';
import { AI_MODELS_MAX_BYTES, AI_MODELS_MAX_COUNT, AI_MODELS_MAX_PAGES, parseAiModelPage } from '../../../../../shared/ai-model-list';
import type { AiRemoteModel } from '../../../../../shared/ai-management';

export interface AiProbeConfig {
  protocol: AiProtocol;
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  headers?: Record<string, string>;
  request?: AiRequestOptions;
}

function authHeaders(protocol: AiProtocol, apiKey: string): Record<string, string> {
  if (protocol === 'anthropic') return { 'x-api-key': apiKey, 'anthropic-version': '2026-10-21' };
  if (protocol === 'gemini') return { 'x-goog-api-key': apiKey };
  return { authorization: `Bearer ${apiKey}` };
}

function modelRequest(config: AiProbeConfig): { path: string; body: unknown } {
  const { prompt, maxOutputTokens } = config.request ?? DEFAULT_AI_REQUEST;
  const messages = [{ role: 'user', content: prompt }];
  const body = (defaults: Record<string, unknown>, controlled: Record<string, unknown>) => mergeAiBody(mergeAiBody(defaults, config.request?.body ?? {}), controlled);
  switch (config.protocol) {
    case 'openai_responses': return { path: 'responses', body: body({ input: prompt }, { model: config.model, max_output_tokens: maxOutputTokens, stream: false, store: false }) };
    case 'anthropic': return { path: 'messages', body: body({ messages }, { model: config.model, max_tokens: maxOutputTokens, stream: false }) };
    case 'gemini': return { path: `models/${encodeURIComponent(config.model)}:generateContent`, body: body({ contents: [{ role: 'user', parts: [{ text: prompt }] }] }, { generationConfig: { maxOutputTokens } }) };
    case 'openai': {
      const payload = body({ messages }, { model: config.model, max_tokens: maxOutputTokens, stream: false });
      if (Object.hasOwn(config.request?.body ?? {}, 'max_completion_tokens')) {
        delete payload.max_tokens;
        payload.max_completion_tokens = maxOutputTokens;
      }
      return { path: 'chat/completions', body: payload };
    }
  }
}

export interface AiProbeResult {
  outcome: AiProbeOutcome;
  statusCode: number;
  latencyMs: number;
  retryAfterSec?: number;
}

export async function probeAiModel(config: AiProbeConfig, budget?: ExternalRequestBudget): Promise<AiProbeResult> {
  const start = Date.now();
  let retryAfterSec = 0;
  const result = (outcome: AiProbeOutcome, statusCode = 0): AiProbeResult => ({ outcome, statusCode, latencyMs: Date.now() - start, ...(retryAfterSec ? { retryAfterSec } : {}) });
  let target: URL;
  let request: ReturnType<typeof modelRequest>;
  try {
    target = aiBaseUrl(config.baseUrl);
    if (!parseAiHeaders(config.headers ?? {}) || !parseAiRequest(config.request ?? DEFAULT_AI_REQUEST)) return result('invalid_config');
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.search || target.hash ||
        !isAiProtocol(config.protocol) || !config.apiKey.trim() || !validAiModelId(config.protocol, config.model) || !Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) return result('invalid_config');
    request = modelRequest(config);
    target.pathname = `${target.pathname}${target.pathname.endsWith('/') ? '' : '/'}${request.path}`;
  } catch {
    return result('invalid_config');
  }

  try {
    budget?.reserve();
    const response = await fetch(target, {
      method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(config.timeoutMs),
      headers: { ...config.headers, 'content-type': 'application/json', ...authHeaders(config.protocol, config.apiKey) },
      body: JSON.stringify(request.body),
    });
    if (response.status === 429) {
      const value = response.headers.get('retry-after') ?? '';
      retryAfterSec = /^\d+$/.test(value) ? Number(value) : Math.max(0, Math.ceil((Date.parse(value) - Date.now()) / 1000));
      if (!Number.isSafeInteger(retryAfterSec) || retryAfterSec < 0) retryAfterSec = 0;
    }
    if ([401,403,404].includes(response.status) || response.status >= 500) {
      await response.body?.cancel().catch(() => {});
      return result(classifyAiResponse(response.status,null),response.status);
    }
    const read = await readCapped(response, 65536);
    if (response.status === 429 && (read.error || read.truncated)) return result('rate_limit_or_quota',response.status);
    if (read.error) return result(isTimeoutAbort(read.error) ? 'timeout' : 'network_error', response.status);
    if (read.truncated) return result('invalid_response', response.status);
    let body: unknown;
    try { body = JSON.parse(read.body); } catch { body = null; }
    return result(classifyAiResponse(response.status, body, config.protocol, config.request?.expectedText), response.status);
  } catch (error) {
    if (error instanceof ExternalBudgetExceeded) throw error;
    if (isWorkerCapacityError(error)) throw new ExternalBudgetExceeded();
    return result(isTimeoutAbort(error) ? 'timeout' : 'network_error');
  }
}

export async function fetchAiModels(config: Omit<AiProbeConfig, 'model'>, allPages = true): Promise<Omit<AiProbeResult, 'outcome'> & { outcome: AiProbeOutcome | 'models_endpoint_unsupported'; models: AiRemoteModel[] }> {
  const start = Date.now();
  const result = (outcome: AiProbeOutcome | 'models_endpoint_unsupported', statusCode = 0, models: AiRemoteModel[] = []) => ({ outcome, statusCode, latencyMs: Date.now() - start, models });
  let target: URL;
  try {
    target = aiBaseUrl(config.baseUrl);
    if (!parseAiHeaders(config.headers ?? {})) return result('invalid_config');
    target.pathname = `${target.pathname}${target.pathname.endsWith('/') ? '' : '/'}models`;
    if (!isAiProtocol(config.protocol) || !config.apiKey || !Number.isInteger(config.timeoutMs) || config.timeoutMs <= 0) return result('invalid_config');
  } catch { return result('invalid_config'); }
  try {
    const signal = AbortSignal.timeout(config.timeoutMs), models = new Map<string, AiRemoteModel>(), seen = new Set<string>();
    let bytes = 0;
    for (let page = 0; page < AI_MODELS_MAX_PAGES; page++) {
      const response = await fetch(target, { method: 'GET', redirect: 'manual', signal, headers: { ...config.headers, ...authHeaders(config.protocol, config.apiKey) } });
      if ([401, 403, 404, 405, 501].includes(response.status) || response.status >= 500 || response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {});
        return result([404, 405, 501].includes(response.status) ? 'models_endpoint_unsupported' : classifyAiResponse(response.status, null), response.status);
      }
      const remaining = AI_MODELS_MAX_BYTES - bytes;
      const read = await readCapped(response, remaining + 1);
      if (read.error) return result(isTimeoutAbort(read.error) ? 'timeout' : 'network_error', response.status);
      const size = new TextEncoder().encode(read.body).byteLength;
      if (read.truncated || size > remaining) return result(response.status === 429 ? 'rate_limit_or_quota' : 'invalid_response', response.status);
      bytes += size;
      let body: unknown;
      try { body = JSON.parse(read.body); } catch { body = null; }
      if (!response.ok) return result(classifyAiResponse(response.status, body), response.status);
      const parsed = parseAiModelPage(config.protocol, body);
      if (!parsed) return result('invalid_response', response.status);
      for (const model of parsed.models) if (!models.has(model.id)) models.set(model.id, model);
      if (models.size > AI_MODELS_MAX_COUNT) return result('invalid_response', response.status);
      if (!allPages || !parsed.cursor) return result('ok', response.status, [...models.values()]);
      if (seen.has(parsed.cursor) || bytes >= AI_MODELS_MAX_BYTES) return result('invalid_response', response.status);
      seen.add(parsed.cursor);
      target.searchParams.set(config.protocol === 'gemini' ? 'pageToken' : 'after_id', parsed.cursor);
    }
    return result('invalid_response', 200);
  } catch (error) { return result(isTimeoutAbort(error) ? 'timeout' : 'network_error'); }
}

export async function probeAiChannel(config: Omit<AiProbeConfig, 'model'>): Promise<Omit<AiProbeResult, 'outcome'> & { outcome: AiProbeOutcome | 'models_endpoint_unsupported' }> {
  const { models: _, ...result } = await fetchAiModels(config, false);
  return result;
}
