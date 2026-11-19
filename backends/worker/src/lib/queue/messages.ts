import type { CheckQueueMessage, CheckQueueTask } from '../../../../../shared/check-queue';
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 64;
const time = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const only = (value: object, keys: string[]) => Object.keys(value).every(key => keys.includes(key));
export function parseQueueMessage(value: unknown): CheckQueueMessage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return null;
  const body = value as CheckQueueMessage;
  if (!['probe', 'checks'].includes(body.type) || !text(body.id) || !text(body.generation) ||
    !time(body.createdAt) || !time(body.expiresAt) || body.expiresAt < body.createdAt ||
    body.expiresAt - body.createdAt > 900)
    return null;
  if (!only(body, ['type', 'id', 'generation', 'createdAt', 'expiresAt', ...(body.type === 'checks' ? ['tasks'] : [])]))
    return null;
  if (body.type === 'checks' && (!Array.isArray(body.tasks) || body.tasks.length < 1 || body.tasks.length > 10 ||
    body.tasks.some(task => !validTask(task, body))))
    return null;
  return body;
}
function validTask(task: CheckQueueTask, body: CheckQueueMessage): boolean {
  return Boolean(task && typeof task === 'object' && !Array.isArray(task) &&
    ['monitor', 'ai', 'subscription'].includes(task.kind) && text(task.id) && text(task.version) && text(task.token) &&
    (task.kind !== 'ai' || text(task.channelVersion)) && time(task.scheduledAt) &&
    task.scheduledAt === body.createdAt && task.expiresAt === body.expiresAt &&
    only(task, ['kind', 'id', 'version', 'channelVersion', 'token', 'scheduledAt', 'expiresAt']));
}
export const sameQueueTask = (a: CheckQueueTask, b: CheckQueueTask) => a.kind === b.kind && a.id === b.id && a.version === b.version && a.channelVersion === b.channelVersion &&
  a.token === b.token && a.scheduledAt === b.scheduledAt && a.expiresAt === b.expiresAt;
