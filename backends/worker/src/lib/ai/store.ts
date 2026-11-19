import type { AiChannel, AiChannelInput, AiModel, AiModelValues } from '../../../../../shared/ai-management';
import { validAiModelId, type AiProtocol } from '../../../../../shared/ai-probe';
import type { DBAdapter } from '../db/adapter';
import { decryptAiCredential, decryptAiHeaders, encryptAiCredential } from './credentials';
import { AiError } from './validation';
import { aiEntry, aiLive, emptyAiRuntime, type AiRuntimeState } from '../../../../../shared/ai-runtime';

export interface ChannelRow {
  id: string; name: string; base_url: string; protocol: AiProtocol; credential_ciphertext: string;
  revision: string; check_revision: string; created_at: number; updated_at: number;
  headers_ciphertext: string; header_names_json: string;
  notification_channel_ids: string;
  notification_enabled: number;
}
interface ModelRow {
  id: string; channel_id: string; name: string; model_id: string; interval_sec: number; timeout_ms: number;
  enabled: number; is_public: number; revision: string; check_revision: string; created_at: number; updated_at: number;
  request_json: string;
}

export function channelView(row: ChannelRow): AiChannel {
  return { id: row.id, name: row.name, baseUrl: row.base_url, protocol: row.protocol, hasApiKey: Boolean(row.credential_ciphertext), headerNames: JSON.parse(row.header_names_json),
    notificationChannelIds: JSON.parse(row.notification_channel_ids), notificationEnabled: row.notification_enabled !== 0, revision: row.revision, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function modelView(row: ModelRow & { channel_name: string }, channelRevision: string, state: AiRuntimeState, available: boolean): AiModel {
  const probe = { revision: row.check_revision, enabled: Boolean(row.enabled), intervalSec: row.interval_sec };
  return { id: row.id, channelId: row.channel_id, channelName: row.channel_name, name: row.name, modelId: row.model_id, intervalSec: row.interval_sec,
    timeoutMs: row.timeout_ms, enabled: Boolean(row.enabled), isPublic: Boolean(row.is_public), revision: row.revision,
    createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), request: JSON.parse(row.request_json),
    live: aiLive(probe, channelRevision, state.models[row.id], Math.floor(Date.now()/1000), available),
    recent: aiEntry(probe, channelRevision, state.models[row.id]).recent };
}

async function channelCheckChanged(previous: ChannelRow, input: AiChannelInput, material: string): Promise<boolean> {
  if (previous.base_url !== input.baseUrl || previous.protocol !== input.protocol) return true;
  try {
    if (input.apiKey !== undefined && input.apiKey !== await decryptAiCredential(previous.credential_ciphertext, previous.id, material)) return true;
    if (input.headers !== undefined) {
      const headers = await decryptAiHeaders(previous.headers_ciphertext, previous.id, material);
      if (Object.keys(headers).length !== Object.keys(input.headers).length || Object.entries(input.headers).some(([name, value]) => headers[name] !== value)) return true;
    }
    return false;
  } catch { return true; }
}

export function aiStorageError(error: unknown, model = false): AiError {
  if (error instanceof AiError) return error;
  const message = String(error), code = (error as { code?: string })?.code;
  if (code === '23505' || /UNIQUE constraint failed/i.test(message)) return new AiError(model ? 'duplicate_model' : 'duplicate_channel_name', 409);
  if (code === '23503' || /FOREIGN KEY constraint failed/i.test(message)) return new AiError('not_found', 404);
  if (code === '42P01' || code === '42703' || /no such table|no such column|has no column|relation .* does not exist/i.test(message)) return new AiError('ai_schema_required', 503);
  return new AiError('ai_storage_unavailable', 503);
}

export class AiStore {
  constructor(private db: DBAdapter) {}
  sql(query: string): string {
    let i = 0;
    return this.db.type === 'postgres' ? query.replace(/\?/g, () => `$${++i}`) : query;
  }

  async channels(): Promise<AiChannel[]> {
    // 密文不进入管理读取。 / Exclude ciphertext from management reads.
    const rows = await this.db.query<ChannelRow>(`SELECT id,name,base_url,protocol,CASE WHEN credential_ciphertext <> '' THEN 'set' ELSE '' END AS credential_ciphertext,header_names_json,notification_channel_ids,notification_enabled,revision,created_at,updated_at FROM ai_channels ORDER BY created_at,id`);
    return rows.map(channelView);
  }
  async channel(id: string): Promise<ChannelRow> {
    const row = await this.db.queryOne<ChannelRow>(this.sql('SELECT * FROM ai_channels WHERE id=?'), [id]);
    if (!row) throw new AiError('not_found', 404);
    return row;
  }
  async models(): Promise<AiModel[]> {
    const rows = await this.db.query<ModelRow & { channel_revision: string; channel_name: string }>('SELECT m.*,c.check_revision AS channel_revision,c.name AS channel_name FROM ai_models m JOIN ai_channels c ON c.id=m.channel_id ORDER BY m.created_at,m.id');
    const runtime = await this.runtime();
    return rows.map(row => modelView(row, row.channel_revision, runtime.state, runtime.available));
  }
  async model(id: string): Promise<AiModel> {
    const row = await this.db.queryOne<ModelRow & { channel_revision: string; channel_name: string }>(this.sql('SELECT m.*,c.check_revision AS channel_revision,c.name AS channel_name FROM ai_models m JOIN ai_channels c ON c.id=m.channel_id WHERE m.id=?'), [id]);
    if (!row) throw new AiError('not_found', 404);
    const runtime = await this.runtime();
    return modelView(row, row.channel_revision, runtime.state, runtime.available);
  }
  async runtime(): Promise<{ state: AiRuntimeState; revision: string; available: boolean }> {
    try {
      const row = await this.db.queryOne<{ json: string; revision: string }>('SELECT json,revision FROM ai_runtime WHERE id=1');
      if (!row) throw new AiError('ai_schema_required', 503);
      return { state: JSON.parse(row.json), revision: row.revision, available: true };
    } catch (error) {
      if (aiStorageError(error).code !== 'ai_schema_required') throw error;
      return { state: emptyAiRuntime(), revision: '', available: false };
    }
  }
  async saveChannel(input: AiChannelInput, material: string, id?: string, revision?: string): Promise<AiChannel> {
    const previous = id ? await this.channel(id) : undefined;
    if (previous && previous.revision !== revision) throw new AiError('revision_conflict', 409);
    if (previous && input.protocol === 'gemini') {
      const models = await this.db.query<{ model_id: string }>(this.sql('SELECT model_id FROM ai_models WHERE channel_id=?'), [previous.id]);
      if (models.some(model => !validAiModelId(input.protocol, model.model_id))) throw new AiError('invalid_ai_model_id');
    }
    id ??= crypto.randomUUID();
    const ciphertext = input.apiKey === undefined ? previous!.credential_ciphertext : await encryptAiCredential(input.apiKey, id, material);
    const headersCiphertext = input.headers === undefined ? previous?.headers_ciphertext ?? '' : Object.keys(input.headers).length ? await encryptAiCredential(JSON.stringify(input.headers), `${id}:headers`, material) : '';
    const headerNames = input.headers === undefined ? JSON.parse(previous?.header_names_json ?? '[]') as string[] : Object.keys(input.headers).sort();
    const notificationChannelIds: string[] = input.notificationChannelIds ?? JSON.parse(previous?.notification_channel_ids ?? '[]');
    const notificationEnabled = input.notificationEnabled ?? previous?.notification_enabled !== 0;
    if (input.notificationChannelIds !== undefined) for (const channelId of notificationChannelIds) {
      if (!await this.db.queryOne(this.sql('SELECT id FROM notifications WHERE id=?'), [channelId])) throw new AiError('notification_channel_not_found');
    }
    const now = Math.floor(Date.now() / 1000), next = crypto.randomUUID();
    const checkRevision = previous && !await channelCheckChanged(previous, input, material) ? previous.check_revision : next;
    const params = [input.name, input.baseUrl, input.protocol, ciphertext, headersCiphertext, JSON.stringify(headerNames), JSON.stringify(notificationChannelIds), Number(notificationEnabled), next, checkRevision, now];
    const result = previous
      ? await this.db.execute(this.sql('UPDATE ai_channels SET name=?,base_url=?,protocol=?,credential_ciphertext=?,headers_ciphertext=?,header_names_json=?,notification_channel_ids=?,notification_enabled=?,revision=?,check_revision=?,updated_at=? WHERE id=? AND revision=?'), [...params, id, revision])
      : await this.db.execute(this.sql('INSERT INTO ai_channels(name,base_url,protocol,credential_ciphertext,headers_ciphertext,header_names_json,notification_channel_ids,notification_enabled,revision,check_revision,updated_at,id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'), [...params, id, now]);
    if (result.rowsAffected !== 1) throw new AiError('revision_conflict', 409);
    return { id, name: input.name, baseUrl: input.baseUrl, protocol: input.protocol, hasApiKey: true, headerNames, notificationChannelIds, notificationEnabled, revision: next, createdAt: Number(previous?.created_at ?? now), updatedAt: now };
  }
  async saveModel(input: AiModelValues, id?: string, revision?: string): Promise<AiModel> {
    const previous = id ? await this.model(id) : undefined;
    if (previous && previous.revision !== revision) throw new AiError('revision_conflict', 409);
    const channel = await this.channel(input.channelId);
    if (!validAiModelId(channel.protocol, input.modelId)) throw new AiError('invalid_ai_model_id');
    const request = input.request ?? previous?.request ?? { prompt: 'Reply OK.', maxOutputTokens: 64, expectedText: '' };
    id ??= crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000), next = crypto.randomUUID();
    const changed = !previous || previous.channelId !== input.channelId || previous.modelId !== input.modelId || previous.intervalSec !== input.intervalSec || previous.timeoutMs !== input.timeoutMs ||
      previous.request.prompt !== request.prompt || previous.request.maxOutputTokens !== request.maxOutputTokens || previous.request.expectedText !== request.expectedText || JSON.stringify(previous.request.body ?? {}) !== JSON.stringify(request.body ?? {});
    const checkRevision = previous && !changed ? previous.live.revision : next;
    const params = [input.channelId, input.name, input.modelId, input.intervalSec, input.timeoutMs, Number(input.enabled), Number(input.isPublic), JSON.stringify(request), next, checkRevision, now];
    const result = previous
      ? await this.db.execute(this.sql('UPDATE ai_models SET channel_id=?,name=?,model_id=?,interval_sec=?,timeout_ms=?,enabled=?,is_public=?,request_json=?,revision=?,check_revision=?,updated_at=? WHERE id=? AND revision=?'), [...params, id, revision])
      : await this.db.execute(this.sql('INSERT INTO ai_models(channel_id,name,model_id,interval_sec,timeout_ms,enabled,is_public,request_json,revision,check_revision,updated_at,id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)'), [...params, id, now]);
    if (result.rowsAffected !== 1) throw new AiError('revision_conflict', 409);
    return this.model(id);
  }
  async remove(kind: 'channels' | 'models', id: string, revision: string): Promise<void> {
    if (kind === 'channels') await this.channel(id); else await this.model(id);
    const removed = await this.db.queryOne<{ id: string }>(this.sql(`DELETE FROM ai_${kind} WHERE id=? AND revision=? RETURNING id`), [id, revision]);
    if (!removed) throw new AiError('revision_conflict', 409);
  }
}
