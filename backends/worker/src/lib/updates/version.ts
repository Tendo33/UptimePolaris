import { Hono } from 'hono';
import { PROJECT_REPOSITORY_URL } from '../../../../../shared/project';
import { STABLE_TAG, type VersionCheck } from '../../../../../shared/project-version';
import { readBoundedBody } from '../http/binary';
import type { Env } from '../../types';

const TTL = 6 * 60 * 60;
const MAX_RELEASE_BYTES = 64 * 1024;
const releaseBase = `${PROJECT_REPOSITORY_URL}/releases/download/`;
const latestRelease = `${PROJECT_REPOSITORY_URL}/releases/latest/download/polaris-update.json`;
const cacheKey = new Request(`${PROJECT_REPOSITORY_URL}/polaris-latest-release-version`);
let latest: VersionCheck | undefined;
let pending: Promise<VersionCheck> | undefined;
let blockedUntil = 0;

class VersionError extends Error {
  constructor(public code: string, public retryAfter = 0, public upstreamStatus = 0) { super(code); }
}

async function fetchVersion(): Promise<VersionCheck> {
  const signal = AbortSignal.timeout(12_000);
  let next = new URL(latestRelease);
  let tag: string | null = null;
  for (let count = 0; count < 5; count++) {
    if (next.protocol !== 'https:' || next.port || next.username || next.password || next.hash) throw new VersionError('version_invalid_response');
    if (next.hostname === 'github.com') {
      if (count !== 0 || next.href !== latestRelease) {
        const path = next.href.startsWith(releaseBase) ? next.href.slice(releaseBase.length) : '';
        const match = /^([^/]+)\/polaris-update\.json$/.exec(path);
        let releaseTag = '';
        try { releaseTag = match ? decodeURIComponent(match[1]) : ''; } catch {}
        if (!STABLE_TAG.test(releaseTag) || tag && tag !== releaseTag) throw new VersionError('version_invalid_response');
        tag = releaseTag;
      }
    } else if (next.hostname !== 'release-assets.githubusercontent.com' || !tag) {
      throw new VersionError('version_invalid_response');
    }
    const response = await fetch(next.href, {
      headers: { Accept: 'application/json', 'User-Agent': 'Uptime-Polaris' },
      redirect: 'manual', signal,
    });
    if (response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))) {
      const retry = Number(response.headers.get('retry-after'));
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      blockedUntil = Math.max(Date.now() + (retry > 0 ? retry : 60) * 1000, Number.isFinite(reset) ? reset : 0);
      throw new VersionError('version_rate_limited', Math.ceil((blockedUntil - Date.now()) / 1000), response.status);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new VersionError('version_invalid_response', 0, response.status);
      await response.body?.cancel();
      try { next = new URL(location, next); } catch { throw new VersionError('version_invalid_response', 0, response.status); }
      continue;
    }
    if (!response.ok) throw new VersionError('version_unavailable', 0, response.status);
    if (!tag || Number(response.headers.get('content-length')) > MAX_RELEASE_BYTES) throw new VersionError('version_invalid_response', 0, response.status);
    let info: { version?: unknown } | null;
    try {
      const bytes = await readBoundedBody(response.body, MAX_RELEASE_BYTES);
      info = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      if (signal.aborted) throw signal.reason;
      throw new VersionError('version_invalid_response', 0, response.status);
    }
    if (typeof info?.version !== 'string' || !STABLE_TAG.test(info.version) || info.version.replace(/^v/, '') !== tag.replace(/^v/, '')) throw new VersionError('version_invalid_response', 0, response.status);
    return { tag, checkedAt: Date.now() };
  }
  throw new VersionError('version_invalid_response');
}

async function readVersion(refresh: boolean): Promise<VersionCheck> {
  const maxAge = (refresh ? 60 : TTL) * 1000;
  if (latest && Date.now() - latest.checkedAt < maxAge) return latest;
  try {
    const cached = await caches.default.match(cacheKey);
    if (cached) {
      const result = await cached.json<VersionCheck>();
      if (Number.isFinite(result.checkedAt) && result.checkedAt <= Date.now() && Date.now() - result.checkedAt < maxAge && (result.tag === null || typeof result.tag === 'string' && STABLE_TAG.test(result.tag))) return latest = result;
    }
  } catch {}
  if (Date.now() < blockedUntil) throw new VersionError('version_rate_limited', Math.ceil((blockedUntil - Date.now()) / 1000));
  if (!pending) pending = fetchVersion().then(async result => {
    latest = result;
    try { await caches.default.put(cacheKey, Response.json(result, { headers: { 'cache-control': `public, max-age=${TTL}` } })); } catch {}
    return result;
  }).finally(() => { pending = undefined; });
  return pending;
}

export const versionRoutes = new Hono<{ Bindings: Env }>();
versionRoutes.get('/api/admin/version', async c => {
  c.header('cache-control', 'private, no-store');
  try { return c.json(await readVersion(c.req.query('refresh') === '1')); }
  catch (error) {
    const code = error instanceof VersionError ? error.code : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'version_timeout' : 'version_unavailable';
    const retryAfter = error instanceof VersionError ? error.retryAfter : 0;
    const upstreamStatus = error instanceof VersionError ? error.upstreamStatus : 0;
    const errorType = error instanceof Error && ['TypeError', 'AbortError', 'TimeoutError'].includes(error.name) ? error.name : 'Error';
    console.warn(JSON.stringify({ event: 'version_check_failed', code, errorType, ...(upstreamStatus ? { upstreamStatus } : {}) }));
    if (retryAfter) c.header('retry-after', String(retryAfter));
    return c.json({ error: code, ...(retryAfter ? { retryAfter } : {}), ...(upstreamStatus ? { upstreamStatus } : {}) }, code === 'version_rate_limited' ? 429 : 502);
  }
});
