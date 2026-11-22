import assert from 'node:assert/strict';
import { agentCapabilities, agentReleaseManifest, downloadAgentArtifact } from '../../backends/worker/src/lib/agent/download';
import { agentReleaseFailureReason, AGENT_RELEASE_REPOSITORY } from '../../backends/worker/src/lib/agent/release';

assert.equal(agentReleaseFailureReason(new DOMException('deadline', 'TimeoutError')), 'github_timeout');
assert.equal(agentReleaseFailureReason(new Error('github_rate_limited')), 'github_rate_limited');
assert.equal(agentReleaseFailureReason(new Error('private details')), 'github_unavailable');

const tag = 'v0.2.0';
const version = '0.2.0';
const file = `polaris-agent-${version}-linux-x86_64`;
const base = `https://github.com/${AGENT_RELEASE_REPOSITORY}/releases/download/${tag}/`;
const latest = `https://github.com/${AGENT_RELEASE_REPOSITORY}/releases/latest/download/manifest.json`;
const asset = 'https://release-assets.githubusercontent.com/fixture/manifest.json';
const entry = { key: 'linux-x86_64', file, version, size: 7, sha256: 'a'.repeat(64) };
const manifest = { repository: AGENT_RELEASE_REPOSITORY, tag, version, platforms: [entry] };
let mode = 'limited';
const calls: string[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = String(input);
  calls.push(url);
  assert.equal(init?.redirect, 'manual');
  assert.notEqual(new URL(url).hostname, 'api.github.com');
  if (mode === 'limited') return new Response('', { status: 403 });
  if (mode === 'missing') return new Response('', { status: 404 });
  if (url === latest) {
    const location = mode === 'redirect_repo' ? 'https://github.com/wrong/repo/releases/download/v0.2.0/manifest.json'
      : mode === 'redirect_http' ? base.replace('https:', 'http:') + 'manifest.json'
      : mode === 'redirect_credentials' ? base.replace('https://', 'https://credential@') + 'manifest.json'
      : mode === 'redirect_cdn' ? asset
      : mode === 'prerelease' ? base.replace(tag, tag + '-rc.1') + 'manifest.json'
      : base + 'manifest.json';
    return new Response(null, { status: 302, headers: mode === 'redirect_missing' ? {} : { location } });
  }
  if (url === base + 'manifest.json') return new Response(null, { status: 302, headers: { location: asset } });
  assert.equal(url, asset);
  if (mode === 'malformed') return new Response('{');
  if (mode === 'large') return new Response('x'.repeat(65537));
  return Response.json(mode === 'bad' ? { ...manifest, repository: 'wrong/repo' }
    : mode === 'tag_mismatch' ? { ...manifest, tag: 'v0.3.0', version: '0.3.0' }
    : mode === 'bad_size' ? { ...manifest, platforms: [{ ...entry, size: 7.5 }] }
    : mode === 'bad_file' ? { ...manifest, platforms: [{ ...entry, file: '../other' }] }
    : mode === 'duplicate' ? { ...manifest, platforms: [entry, entry] }
    : manifest);
}) as typeof fetch;
function context(file = '') {
  return {
    env: {}, req: { url: 'https://site.test/api/public/agent/download', param: () => file },
    json: (body: unknown, status = 200) => ({ body, status }), header: () => undefined,
    body: (body: BodyInit | null) => new Response(body),
  };
}
async function expectFailure(scenario: string, error: string, status = 502) {
  mode = scenario;
  const result = await agentCapabilities(context() as never) as { status: number; body: { error: string } };
  assert.equal(result.status, status, scenario);
  assert.equal(result.body.error, error, scenario);
}
await expectFailure('limited', 'github_rate_limited');
await expectFailure('missing', 'release_not_found', 501);
for (const scenario of ['redirect_repo', 'redirect_http', 'redirect_credentials', 'redirect_cdn', 'redirect_missing', 'prerelease']) {
  await expectFailure(scenario, 'invalid_release_redirect');
}
for (const scenario of ['bad', 'tag_mismatch', 'bad_size', 'bad_file', 'duplicate', 'malformed']) {
  await expectFailure(scenario, 'invalid_release_manifest');
}
await expectFailure('large', 'release_response_too_large');
mode = 'good';
const before = calls.length;
const [good, concurrent] = await Promise.all([
  agentReleaseManifest(context() as never), agentCapabilities(context() as never),
]) as Array<{ body: typeof manifest }>;
assert.deepEqual(good.body, manifest);
assert.deepEqual(concurrent.body, manifest);
assert.deepEqual(calls.slice(before), [latest, base + 'manifest.json', asset]);
const beforeDownload = calls.length;
const redirect = await downloadAgentArtifact(context('polaris-agent-linux-x86_64') as never) as Response;
assert.equal(redirect.status, 302);
assert.equal(redirect.headers.get('location'), base + file);
assert.equal(calls.length, beforeDownload);
assert.equal((await downloadAgentArtifact(context('polaris-agent-windows-aarch64.exe') as never) as { status: number }).status, 422);
assert.equal((await downloadAgentArtifact(context('polaris-agent-darwin-aarch64') as never) as { status: number }).status, 501);
assert.equal((await downloadAgentArtifact(context('polaris-agent-0.1.0-linux-x86_64') as never) as { status: number }).status, 501);
console.log('PASS Agent release discovery without the GitHub API, redirect/manifest validation, downloads, and shared cache');
