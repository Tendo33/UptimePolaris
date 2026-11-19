import { aiLiveTone, aiStatusKey } from '@/components/ai/status';
import type { Tone } from '@/types/tone';
import type { AiChannel, AiManualResult, AiModel } from '../../../../shared/ai-management';
import type { AiProtocol } from '../../../../shared/ai-probe';

export type AiBucket = 'up' | 'down' | 'unknown' | 'paused';
export const AI_BUCKETS: AiBucket[] = ['down', 'unknown', 'up', 'paused'];

/** Request path the backend appends to the channel's base URL. / 后端在渠道地址后追加的请求路径。 */
export const PROTOCOL_PATH: Record<AiProtocol, string> = {
  openai: 'chat/completions',
  openai_responses: 'responses',
  anthropic: 'messages',
  gemini: 'models/{model}:generateContent',
};

export const PROTOCOL_BASE_URL: Record<AiProtocol, string> = {
  openai: 'https://api.openai.com/v1',
  openai_responses: 'https://api.openai.com/v1',
  anthropic: 'https://api.anthropic.com/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta',
};

export const PROTOCOL_SHORT: Record<AiProtocol, string> = {
  openai: 'OpenAI',
  openai_responses: 'Responses',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};

export function aiBucket(model: AiModel, unavailable = false): AiBucket {
  if (!model.enabled) return 'paused';
  if (unavailable) return 'unknown';
  const key = aiStatusKey(model.live);
  return key === 'up' ? 'up' : key === 'down' ? 'down' : 'unknown';
}

export function aiTone(model: AiModel, unavailable = false): Tone {
  return model.enabled ? aiLiveTone(model.live, unavailable) : 'idle';
}

export function bucketCounts(models: AiModel[], unavailable = false) {
  const counts = { total: models.length, up: 0, down: 0, unknown: 0, paused: 0 };
  for (const model of models) counts[aiBucket(model, unavailable)]++;
  return counts;
}

/** The full URL a model check posts to, or null while the base URL is not a URL yet. / 模型检查实际请求的完整地址；基础地址无效时返回 null。 */
export function requestUrl(channel: Pick<AiChannel, 'baseUrl' | 'protocol'>, modelId = '{model}'): string | null {
  try {
    const url = new URL(channel.baseUrl.trim());
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    const path = PROTOCOL_PATH[channel.protocol].replace('{model}', modelId === '{model}' ? modelId : encodeURIComponent(modelId));
    url.pathname = `${url.pathname}${url.pathname.endsWith('/') ? '' : '/'}${path}`;
    return decodeURI(url.href);
  } catch {
    return null;
  }
}

/** The connection check lists models under the base URL for every protocol. / 各协议的连接检查都请求基础地址下的模型列表。 */
export function modelsUrl(baseUrl: string): string | null {
  try {
    const url = new URL(baseUrl.trim());
    url.pathname = `${url.pathname}${url.pathname.endsWith('/') ? '' : '/'}models`;
    return url.href;
  } catch {
    return null;
  }
}

/** Sort oldest first so a save does not move the row. / 按创建时间排序，保存后行不会移动。 */
export const byCreated = <T extends { createdAt: number; name: string }>(a: T, b: T) => a.createdAt - b.createdAt || a.name.localeCompare(b.name);

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** Every model field the update endpoint requires, so a row toggle can save one change. / 更新接口要求的完整字段，便于行内开关只修改一项。 */
export function modelUpdate(model: AiModel, patch: Partial<Pick<AiModel, 'enabled' | 'isPublic'>>) {
  return {
    channelId: model.channelId,
    name: model.name,
    modelId: model.modelId,
    intervalSec: model.intervalSec,
    timeoutMs: model.timeoutMs,
    enabled: model.enabled,
    isPublic: model.isPublic,
    request: model.request,
    revision: model.revision,
    ...patch,
  };
}

export type ManualResults = Record<string, AiManualResult>;

/** A manual result only describes the configuration it ran against. / 手动检查结果只对应其运行时的配置版本。 */
export function manualResult(results: ManualResults, kind: 'channel' | 'model', id: string, revision: string, channelRevision: string) {
  const result = results[`${kind}:${id}`];
  return result?.revision === revision && result.channelRevision === channelRevision ? result : undefined;
}

export type AiSort = 'created' | 'status' | 'name' | 'availability' | 'latency';
export const AI_SORTS: AiSort[] = ['created', 'status', 'name', 'availability', 'latency'];
const BUCKET_RANK: Record<AiBucket, number> = { down: 0, unknown: 1, up: 2, paused: 3 };

/** Worst first for status, lowest first for availability, slowest first for latency. / 状态按严重程度、可用率从低到高、耗时从慢到快排序。 */
export function sortModels(models: AiModel[], sort: AiSort, unavailable = false): AiModel[] {
  const list = [...models].sort(byCreated);
  const missingLast = (value: number | null, fallback: number) => (value === null ? fallback : value);
  switch (sort) {
    case 'status':
      return list.sort((a, b) => BUCKET_RANK[aiBucket(a, unavailable)] - BUCKET_RANK[aiBucket(b, unavailable)]);
    case 'name':
      return list.sort((a, b) => a.name.localeCompare(b.name));
    case 'availability':
      return list.sort((a, b) => missingLast(a.live.availabilityPct, Infinity) - missingLast(b.live.availabilityPct, Infinity));
    case 'latency':
      return list.sort((a, b) => missingLast(b.live.latencyMs, -1) - missingLast(a.live.latencyMs, -1));
    default:
      return list;
  }
}

/** Availability across every check the channel's models have run. / 渠道下所有模型全部检查的总体可用率。 */
export function channelAvailability(models: AiModel[]): number | null {
  let ok = 0;
  let total = 0;
  for (const model of models) {
    ok += model.live.ok;
    total += model.live.total;
  }
  return total ? (ok * 100) / total : null;
}

export type AiBulkOp = 'pause' | 'resume' | 'public' | 'private' | 'delete';
export const BULK_PATCH: Record<Exclude<AiBulkOp, 'delete'>, Partial<Pick<AiModel, 'enabled' | 'isPublic'>>> = {
  pause: { enabled: false },
  resume: { enabled: true },
  public: { isPublic: true },
  private: { isPublic: false },
};

/** Models an operation would actually change; the rest are skipped. / 操作实际会改变的模型，其余跳过。 */
export function bulkTargets(models: AiModel[], op: AiBulkOp): AiModel[] {
  if (op === 'delete') return models;
  const patch = BULK_PATCH[op];
  return models.filter((model) => (patch.enabled !== undefined && model.enabled !== patch.enabled) || (patch.isPublic !== undefined && model.isPublic !== patch.isPublic));
}
