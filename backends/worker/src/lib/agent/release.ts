import source from '../../../../../shared/agent-release-repository.json';

export const AGENT_RELEASE_REPOSITORY = source.repository;
export const PROBE_PLATFORMS: Record<string, string> = {
  'linux-x86_64': '', 'linux-aarch64': '', 'windows-x86_64': '.exe',
  'darwin-x86_64': '', 'darwin-aarch64': '',
};
export interface AgentPlatform { key: string; file: string; size: number; sha256: string; version: string }
export interface AgentManifest { repository: string; tag: string; version: string; platforms: AgentPlatform[] }
let cached: { value: AgentManifest; until: number; checkedAt: number } | undefined;
let pending: Promise<AgentManifest> | undefined;

const releaseBase = `https://github.com/${AGENT_RELEASE_REPOSITORY}/releases/download/`;
const latestManifest = `https://github.com/${AGENT_RELEASE_REPOSITORY}/releases/latest/download/manifest.json`;

// 每次跳转都检查目标；流式计数不依赖 Content-Length 是否存在或准确。
// Check each redirect target; count streamed bytes independently of Content-Length.
async function requestManifest(): Promise<{ value: unknown; tag: string }> {
  let next = new URL(latestManifest);
  let response: Response | undefined;
  let tag: string | undefined;
  const signal = AbortSignal.timeout(10000);
  for (let count = 0; count < 5; count++) {
    if (next.protocol !== 'https:' || next.port || next.username || next.password || next.hash) throw new Error('invalid_release_redirect');
    if (next.hostname === 'github.com') {
      if (count !== 0 || next.href !== latestManifest) {
        const path = next.href.startsWith(releaseBase) ? next.href.slice(releaseBase.length) : '';
        const match = /^(v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))\/manifest\.json$/.exec(path);
        if (!match || (tag && tag !== match[1])) throw new Error('invalid_release_redirect');
        tag = match[1];
      }
    } else if (next.hostname !== 'release-assets.githubusercontent.com' || !tag) {
      throw new Error('invalid_release_redirect');
    }
    response = await fetch(next.toString(), { headers: { 'User-Agent': 'Uptime-Polaris', Accept: 'application/json' }, signal, redirect: 'manual' });
    if (response.status < 300 || response.status >= 400) break;
    const location = response.headers.get('location');
    if (!location) throw new Error('invalid_release_redirect');
    next = new URL(location, next);
    response = undefined;
  }
  if (!response) throw new Error('invalid_release_redirect');
  if (!response.ok) throw new Error(response.status === 403 || response.status === 429 ? 'github_rate_limited' : response.status === 404 ? 'release_not_found' : 'github_unavailable');
  if (!tag) throw new Error('invalid_release_redirect');
  const limit = 65536;
  if (Number(response.headers.get('content-length')) > limit) throw new Error('release_response_too_large');
  if (!response.body) throw new Error('empty_release_response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.length;
      if (length > limit) { await reader.cancel(); throw new Error('release_response_too_large'); }
      chunks.push(next.value);
    }
  } finally { reader.releaseLock(); }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try { return { value: JSON.parse(new TextDecoder().decode(bytes)), tag }; }
  catch { throw new Error('invalid_release_manifest'); }
}

async function load(): Promise<AgentManifest> {
  const { value, tag } = await requestManifest();
  const manifest = value as AgentManifest;
  const version = tag.slice(1);
  if (!manifest || manifest.repository !== AGENT_RELEASE_REPOSITORY || manifest.tag !== tag || manifest.version !== version || !Array.isArray(manifest.platforms) || !manifest.platforms.length) throw new Error('invalid_release_manifest');
  const seen = new Set<string>();
  for (const item of manifest.platforms) {
    if (!item || typeof item.key !== 'string' || !Object.hasOwn(PROBE_PLATFORMS, item.key) || seen.has(item.key) || item.version !== version || item.file !== `polaris-agent-${version}-${item.key}${PROBE_PLATFORMS[item.key]}` || !Number.isSafeInteger(item.size) || item.size <= 0 || item.size > 64 * 1024 * 1024 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('invalid_release_manifest');
    seen.add(item.key);
  }
  return manifest;
}
/** 成功结果缓存五分钟，并合并同一实例内的并发刷新。 / Cache successful results for five minutes and share concurrent refreshes within this instance. */
export async function latestAgentRelease(refresh = false): Promise<AgentManifest> {
  if (cached && cached.until > Date.now() && (!refresh || Date.now() - cached.checkedAt < 60_000)) return cached.value;
  pending ??= load().then(value => { const now = Date.now(); cached = { value, until: now + 300_000, checkedAt: now }; return value; }).finally(() => { pending = undefined; });
  return pending;
}
export function cachedAgentRelease(): AgentManifest | null {
  return cached && cached.until > Date.now() ? cached.value : null;
}
export function releaseUrl(manifest: AgentManifest, file: string): string {
  return `https://github.com/${AGENT_RELEASE_REPOSITORY}/releases/download/${manifest.tag}/${file}`;
}
