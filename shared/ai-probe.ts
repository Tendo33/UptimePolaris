export const AI_PROTOCOLS = ['openai', 'openai_responses', 'anthropic', 'gemini'] as const;
export type AiProtocol = typeof AI_PROTOCOLS[number];

export function isAiProtocol(value: unknown): value is AiProtocol {
  return AI_PROTOCOLS.some(protocol => protocol === value);
}

export function validAiModelId(protocol: AiProtocol, model: string): boolean {
  return Boolean(model.trim()) && (protocol !== 'gemini' || /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model));
}

export type AiProbeOutcome =
  | 'ok'
  | 'authentication_failed'
  | 'permission_denied'
  | 'model_or_endpoint_unavailable'
  | 'rate_limited'
  | 'quota_exhausted'
  | 'rate_limit_or_quota'
  | 'upstream_unavailable'
  | 'request_invalid'
  | 'invalid_config'
  | 'timeout'
  | 'network_error'
  | 'invalid_response'
  | 'response_mismatch'
  | 'unexpected_status';

const quotaCodes = new Set([
  'insufficient_quota', 'credit_balance_exhausted', 'organization_spend_limit_exceeded',
  'project_spend_limit_exceeded', 'organization_usage_limit_exceeded', 'usage_limit_exceeded',
]);
const rateCodes = new Set(['rate_limit_exceeded', 'rate_limit_error', 'slow_down']);

export function classifyAiResponse(status: number, body: unknown, protocol: AiProtocol = 'openai', expectedText = ''): AiProbeOutcome {
  if (status === 401) return 'authentication_failed';
  if (status === 403) return 'permission_denied';
  if (status === 404) return 'model_or_endpoint_unavailable';
  if (status === 429) {
    const error = object(object(body)?.error);
    const codes = [error?.code, error?.type].filter((value): value is string => typeof value === 'string');
    if (codes.some(code => quotaCodes.has(code))) return 'quota_exhausted';
    if (codes.some(code => rateCodes.has(code))) return 'rate_limited';
    return 'rate_limit_or_quota';
  }
  if (status >= 500 && status <= 599) return 'upstream_unavailable';
  if (status >= 400 && status <= 499) return 'request_invalid';
  if (status < 200 || status > 299) return 'unexpected_status';
  const response = object(body);
  if (response?.error != null) return 'invalid_response';
  if (expectedText && classifyAiResponse(status, body, protocol) === 'ok') return aiResponseText(body, protocol).includes(expectedText) ? 'ok' : 'response_mismatch';
  if (protocol === 'openai_responses') {
    if (response?.status !== 'completed' && response?.status !== 'incomplete') return 'invalid_response';
    const output = response.output;
    return Array.isArray(output) && output.some(item => {
      const message = object(item);
      return message?.type === 'message' && message.role === 'assistant' && hasText(message.content, 'output_text');
    }) ? 'ok' : 'invalid_response';
  }
  if (protocol === 'anthropic') return response?.type === 'message' && response.role === 'assistant' && hasText(response.content, 'text') ? 'ok' : 'invalid_response';
  if (protocol === 'gemini') {
    const candidates = response?.candidates;
    return Array.isArray(candidates) && candidates.some(item => {
      const parts = object(object(item)?.content)?.parts;
      return Array.isArray(parts) && parts.some(part => object(part)?.thought !== true && nonempty(object(part)?.text));
    }) ? 'ok' : 'invalid_response';
  }
  const choices = response?.choices;
  if (!Array.isArray(choices)) return 'invalid_response';
  const content = object(object(choices[0])?.message)?.content;
  return nonempty(content) ? 'ok' : 'invalid_response';
}

export function aiResponseText(body: unknown, protocol: AiProtocol): string {
  const response = object(body);
  const blocks = (value: unknown, type: string) => Array.isArray(value) ? value.filter(block => object(block)?.type === type).map(block => object(block)?.text).filter((text): text is string => typeof text === 'string') : [];
  if (protocol === 'openai_responses') return (Array.isArray(response?.output) ? response.output : []).flatMap(item => object(item)?.type === 'message' && object(item)?.role === 'assistant' ? blocks(object(item)?.content, 'output_text') : []).join('\n');
  if (protocol === 'anthropic') return blocks(response?.content, 'text').join('\n');
  if (protocol === 'gemini') return (Array.isArray(response?.candidates) ? response.candidates : []).flatMap(item => {
    const parts = object(object(item)?.content)?.parts;
    return Array.isArray(parts) ? parts.filter(part => object(part)?.thought !== true).map(part => object(part)?.text).filter((text): text is string => typeof text === 'string') : [];
  }).join('\n');
  const choices = response?.choices;
  const content = Array.isArray(choices) ? object(object(choices[0])?.message)?.content : undefined;
  return typeof content === 'string' ? content : '';
}

function nonempty(value: unknown): boolean {
  return typeof value === 'string' && Boolean(value.trim());
}

function hasText(value: unknown, type: string): boolean {
  return Array.isArray(value) && value.some(block => object(block)?.type === type && nonempty(object(block)?.text));
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
