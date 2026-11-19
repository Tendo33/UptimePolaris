import type { AiRemoteModel } from './ai-management';
import { validAiModelId, type AiProtocol } from './ai-probe';

export const AI_MODELS_MAX_BYTES = 2 * 1024 * 1024;
export const AI_MODELS_MAX_PAGES = 10;
export const AI_MODELS_MAX_COUNT = 10_000;

export function parseAiModelPage(protocol: AiProtocol, value: unknown): { models: AiRemoteModel[]; cursor: string | null } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const rows = body[protocol === 'gemini' ? 'models' : 'data'];
  if (!Array.isArray(rows) || body.error != null) return null;
  const models: AiRemoteModel[] = [];
  for (const value of rows) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const row = value as Record<string, unknown>;
    if (protocol === 'gemini' && Array.isArray(row.supportedGenerationMethods) && !row.supportedGenerationMethods.includes('generateContent')) continue;
    const raw = protocol === 'gemini' ? row.name : row.id;
    if (typeof raw !== 'string') continue;
    const id = (protocol === 'gemini' ? raw.replace(/^models\//, '') : raw).trim();
    if (!validAiModelId(protocol, id) || [...id].length > 200 || /[\u0000-\u001f\u007f]/.test(id)) continue;
    const display = protocol === 'gemini' ? row.displayName : row.display_name;
    const name = typeof display === 'string' ? [...display.replace(/[\u0000-\u001f\u007f]/g, '').trim()].slice(0, 120).join('') : '';
    models.push({ id, name: name || null });
  }
  const next = protocol === 'gemini' ? body.nextPageToken : body.has_more === true ? body.last_id : null;
  if (next != null && next !== '' && (typeof next !== 'string' || next.length > 2048 || /[\u0000-\u001f\u007f]/.test(next))) return null;
  if (protocol !== 'gemini' && body.has_more === true && !next) return null;
  return { models, cursor: typeof next === 'string' && next ? next : null };
}
