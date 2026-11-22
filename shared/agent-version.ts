export type AgentVersionState = 'current' | 'behind' | 'unknown' | 'not_reported';

export function agentVersionState(actual: string | null, latest: string | null): AgentVersionState {
  if (!actual) return 'not_reported';
  if (!latest) return 'unknown';
  const parse = (version: string) => {
    if (!/^\d+\.\d+\.\d+$/.test(version)) return null;
    const parts = version.split('.').map(Number);
    return parts.every(Number.isSafeInteger) ? parts : null;
  };
  const current = parse(actual), target = parse(latest);
  if (!current || !target) return 'unknown';
  for (let index = 0; index < 3; index++) {
    if (current[index] !== target[index]) return current[index] < target[index] ? 'behind' : 'current';
  }
  return 'current';
}
