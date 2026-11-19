export function notificationChannelIds(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > 32 || value.some(id => typeof id !== 'string' || !id || id.length > 64 || id.trim() !== id) || new Set(value).size !== value.length) return null;
  return value as string[];
}

export function monitorNotificationIds(optionsJson: string): string[] {
  return JSON.parse(optionsJson).notificationChannelIds ?? [];
}
