import type { AiProbeOutcome, AiProtocol } from './ai-probe';
import type { AiRequestOptions } from './ai-request';

export interface AiChannel {
  id: string;
  name: string;
  baseUrl: string;
  protocol: AiProtocol;
  hasApiKey: boolean;
  headerNames: string[];
  notificationChannelIds: string[];
  notificationEnabled: boolean;
  revision: string;
  createdAt: number;
  updatedAt: number;
}

export interface AiChannelInput {
  name: string;
  baseUrl: string;
  protocol: AiProtocol;
  apiKey?: string;
  headers?: Record<string, string>;
  notificationChannelIds?: string[];
  notificationEnabled?: boolean;
}

export interface AiChannelDetails extends AiChannel {
  headers: Record<string, string>;
}

export interface AiModel {
  id: string;
  channelId: string;
  channelName: string;
  name: string;
  modelId: string;
  intervalSec: number;
  timeoutMs: number;
  enabled: boolean;
  isPublic: boolean;
  revision: string;
  createdAt: number;
  updatedAt: number;
  request: AiRequestOptions;
  live: AiModelLive;
  /** Latest scheduled checks for the status rail, oldest first, at most 60. Manual checks are excluded. / 状态条使用的最近定时检查，按时间从旧到新，最多 60 条，不含手动检查。 */
  recent?: AiRecentCheck[];
}

export interface AiModelInput {
  channelId: string;
  name: string;
  modelId: string;
  intervalSec?: number;
  timeoutMs?: number;
  enabled?: boolean;
  isPublic?: boolean;
  request?: AiRequestOptions;
}

export type AiModelValues = Required<Omit<AiModelInput, 'request'>> & Pick<AiModelInput, 'request'>;

export type AiChannelUpdate = AiChannelInput & { revision: string };
export type AiChannelCreate = AiChannelInput & { apiKey: string };
export type AiModelUpdate = AiModelValues & { revision: string };
export interface AiRevisionInput { revision: string }
export interface AiModelCheckInput extends AiRevisionInput { channelRevision: string; confirmPaid: true }

export interface AiManualResult {
  kind: 'channel' | 'model';
  checkedAt: number;
  revision: string;
  channelRevision: string;
  outcome: AiProbeOutcome | 'models_endpoint_unsupported';
  statusCode: number;
  latencyMs: number;
}

export type AiManagementError =
  | 'unauthorized' | 'invalid_origin' | 'invalid_request' | 'invalid_ai_url' | 'invalid_ai_model_id' | 'api_key_required' | 'not_found'
  | 'revision_conflict' | 'duplicate_channel_name' | 'duplicate_model' | 'invalid_ai_headers' | 'invalid_ai_request' | 'ai_disabled'
  | 'paid_confirmation_required' | 'ai_key_material_unavailable'
  | 'ai_credential_decryption_failed' | 'ai_schema_required' | 'ai_storage_unavailable' | 'notification_channel_not_found'
  | 'ai_models_unavailable';

export type AiSkipReason = 'budget_exhausted' | 'source_unavailable' | 'credential_unavailable' | 'configuration_invalid' | 'channel_backoff' | 'runtime_unavailable' | null;
export interface AiModelLive {
  checkedAt: number | null;
  outcome: AiProbeOutcome | null;
  latencyMs: number | null;
  statusCode: number;
  revision: string;
  channelRevision: string;
  runId: string | null;
  nextCheckAt: number;
  lastAttemptAt: number | null;
  skipReason: AiSkipReason;
  freshness: 'never_checked' | 'current' | 'stale' | 'paused' | 'configuration_changed';
  total: number;
  ok: number;
  availabilityPct: number | null;
  consecutiveFailures: number;
}
export interface AiDayStat {
  date: string;
  total: number;
  ok: number;
  availabilityPct: number | null;
  avgLatencyMs: number | null;
  exact: true;
}
export interface AiHistoryPoint {
  checkedAt: number;
  outcome: AiProbeOutcome;
  latencyMs: number;
  statusCode: number;
  revision: string;
  channelRevision: string;
  runId: string;
}
export interface AiModelHistory {
  modelId: string;
  days: AiDayStat[];
  // Latest 100 raw observations in the requested window.
  points: AiHistoryPoint[];
  detailStatus: 'ready' | 'unconfigured' | 'unavailable';
  sampled: boolean;
}
export interface PublicAiModel {
  id: string;
  name: string;
  channel: { id: string; name: string };
  intervalSec: number;
  live: AiModelLive;
  /** Same as `AiModel.recent`. / 同 `AiModel.recent`。 */
  recent?: AiRecentCheck[];
}

/** One scheduled check in a model's status rail. / 模型状态条中的一次定时检查。 */
export interface AiRecentCheck {
  checkedAt: number;
  outcome: AiProbeOutcome;
  latencyMs: number;
  statusCode: number;
}

/**
 * GET /api/admin/ai/channels/:id/models lists what the channel offers, read from its models endpoint.
 * An upstream failure answers 502 `{ error: 'ai_models_unavailable', outcome }`.
 *
 * GET /api/admin/ai/channels/:id/models 读取渠道的模型列表接口；上游失败时返回 502 `{ error: 'ai_models_unavailable', outcome }`。
 */
export interface AiRemoteModel {
  id: string;
  /** Display name when the provider gives one. / 服务商提供的显示名称。 */
  name: string | null;
}
export interface AiRemoteModels {
  models: AiRemoteModel[];
  fetchedAt: number;
}
