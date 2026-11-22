import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { applyD1Migrations } from '../helpers/apply-d1-migrations.mjs';

const fixture = JSON.parse(readFileSync('test/themes/fixtures/builtin-theme.json', 'utf8'));
const shared = await build({ stdin: { contents: "export * from './shared/presentation'; export * from './shared/builtin-theme';", resolveDir: process.cwd(), loader: 'ts' }, bundle: true, write: false, format: 'esm', logLevel: 'error' });
const { builtinThemeOptions, validateBuiltinThemeOptions, resolveBuiltinPageView, defaultPresentation, parsePresentation, HEAD_CODE_MAX_BYTES, CONTENT_HTML_MAX_BYTES } = await import('data:text/javascript;base64,' + Buffer.from(shared.outputFiles[0].text).toString('base64'));
for (const kind of ['monitor', 'agent']) {
  const options = builtinThemeOptions(kind);
  assert.deepEqual(Object.fromEntries(options.map(option => [option.key, option.default])), fixture.defaults[kind]);
  assert.ok(options.every(option => option.label === option.key));
  const page = { theme: null, themeOptions: fixture.configured[kind] };
  const view = resolveBuiltinPageView(kind, page);
  for (const [key, value] of Object.entries(fixture.configured[kind])) assert.equal(view[key], value);
}
for (const item of fixture.cases) {
  assert.equal(validateBuiltinThemeOptions(item.kind, item.values), item.valid, item.name);
  const config = defaultPresentation();
  config.pages[item.kind].themeOptions = item.values;
  assert.equal(parsePresentation(config) !== null, item.valid, item.name);
}
for (const [key, limit] of [['headCode', HEAD_CODE_MAX_BYTES], ['contentHtml', CONTENT_HTML_MAX_BYTES]]) {
  const config = defaultPresentation();
  const text = '界'.repeat(Math.floor(limit / 3)) + 'x'.repeat(limit % 3);
  config.pages.monitor[key] = text;
  assert.ok(parsePresentation(config), key + ' exact UTF-8 limit');
  config.pages.monitor[key] += 'x';
  assert.equal(parsePresentation(config), null, key + ' UTF-8 overflow');
}
assert.equal(resolveBuiltinPageView('agent', { theme: null, themeOptions: { showCountry: true }, showCountry: false }).showCountry, false, 'options cannot override a privacy gate');
assert.equal(resolveBuiltinPageView('monitor', { theme: { short: 'x', version: '1', theme: 'x' }, themeOptions: { radius: 99 } }).radius, 12, 'installed options are not built-in view overrides');

const bundle = await build({ entryPoints: ['backends/worker/src/api.ts'], bundle: true, write: false, format: 'esm', target: 'es2022', logLevel: 'error',
  plugins: [{ name: 'stub', setup(b) { b.onResolve({ filter: /^(postgres|cloudflare:sockets)$/ }, ({ path }) => ({ path, namespace: 'fixture' })); b.onLoad({ filter: /.*/, namespace: 'fixture' }, ({ path }) => ({ contents: path === 'postgres' ? 'export default function(){throw new Error("unexpected postgres")}' : 'export function connect(){throw new Error("unexpected connect")}' })); } }],
  footer: { js: 'export default { fetch: api.fetch.bind(api) };' },
});
const mf = new Miniflare({ modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2025-01-01', d1Databases: { DB: 'builtin-theme' }, r2Buckets: { THEMES: 'builtin-theme' }, bindings: { ADMIN_TOKEN: 'fixture', DATABASE_TYPE: 'd1' } });
const auth = { authorization: 'Bearer fixture', 'content-type': 'application/json' };
async function request(path, init = {}, host = 'localhost') {
  const response = await mf.dispatchFetch('https://' + host + path, init);
  return { status: response.status, body: await response.json() };
}
async function write(path, method, value) {
  const result = await request(path, { method, headers: auth, body: JSON.stringify(value) });
  assert.ok(result.status >= 200 && result.status < 300, JSON.stringify(result));
  return result.body;
}
const publicConfig = kind => request('/api/public/config?fresh=1&preview=' + kind, { headers: auth });
try {
  const db = await mf.getD1Database('DB');
  await applyD1Migrations(db);
  let state = (await request('/api/admin/presentation', { headers: auth })).body;
  let config = structuredClone(state.config);
  const save = async () => {
    state = await write('/api/admin/presentation', 'PUT', { config, revision: state.revision });
    config = structuredClone(state.config);
  };
  const baseline = (await publicConfig('monitor')).body;
  for (const kind of ['monitor', 'agent']) {
    const response = await publicConfig(kind);
    assert.equal(response.status, 200);
    for (const [key, value] of Object.entries(fixture.defaults[kind])) assert.equal(response.body.presentation[key], value);
    config.pages[kind].themeOptions = fixture.configured[kind];
    config.pages[kind].headCode = '<style data-page="' + kind + '">body{opacity:1}</style>';
    config.pages[kind].contentHtml = '<p>' + kind + ' content</p>';
  }
  config.agentEnabled = true;
  config.domains = [{ hostname: 'localhost', page: 'monitor' }, { hostname: 'agent.test', page: 'agent' }];
  await save();
  for (const kind of ['monitor', 'agent']) {
    const { body } = await publicConfig(kind);
    assert.equal(body.theme, null);
    assert.equal(body.theme_settings, null);
    assert.equal(body.theme_head_code, config.pages[kind].headCode);
    assert.equal(body.theme_content_html, config.pages[kind].contentHtml);
    assert.deepEqual(body.siteMeta, baseline.siteMeta);
    for (const [key, value] of Object.entries(fixture.configured[kind])) assert.equal(body.presentation[key], value);
  }
  for (const patch of [{ themeOptions: { radius: 1.5 } }, { themeOptions: { title: 'forbidden' } }, { headCode: '界'.repeat(5462) }]) {
    const bad = structuredClone(config);
    Object.assign(bad.pages.monitor, patch);
    const response = await request('/api/admin/presentation', { method: 'PUT', headers: auth, body: JSON.stringify({ config: bad, revision: state.revision }) });
    assert.equal(response.status, 400);
    assert.equal(response.body.error, 'invalid_presentation');
  }
  const fallback = await request('/api/public/config?fresh=1', {}, 'other.test');
  assert.equal(fallback.body.presentation.configured, true);
  assert.equal(fallback.body.presentation.kind, 'monitor');
  assert.equal(fallback.body.theme_head_code, config.pages.monitor.headCode);
  assert.equal(fallback.body.theme_content_html, config.pages.monitor.contentHtml);
  const machine = await write('/api/admin/agents', 'POST', { name: 'country fixture' });
  await write('/api/admin/agents/visibility', 'POST', { ids: [machine.id], is_public: true });
  await db.prepare('INSERT INTO machine_live(agent_id,region,updated_at) VALUES(?,?,0)').bind(machine.id, 'private city, US').run();
  let servers = await request('/api/public/servers?preview=agent', { headers: auth });
  assert.equal(servers.body.servers.length, 1);
  assert.equal(servers.body.servers[0].region, undefined);
  config.pages.agent.themeOptions.showCountry = true;
  await save();
  servers = await request('/api/public/servers?preview=agent', { headers: auth });
  assert.equal(servers.body.servers[0].region, 'US');

  const manifest = { schema: 2, id: 'builtin-check', short: 'builtin-check', name: 'Fixture', version: '1.0.0', themes: [{ id: 'monitor', name: 'Monitor', target: 'monitor', entry: 'index.html', capabilities: ['public.config'], options: [{ key: 'accent', label: 'Accent', type: 'color', default: '#123456' }] }] };
  const prefix = 'themes/builtin-check/1.0.0/' + 'a'.repeat(64) + '/00000000-0000-0000-0000-000000000001';
  await db.prepare('INSERT INTO themes(short,id,name,version,manifest_json,installed_at,updated_at) VALUES(?,?,?,?,?,?,?)').bind('builtin-check', 'builtin-check', 'Fixture', '1.0.0', JSON.stringify(manifest), 1, 1).run();
  await db.prepare('INSERT INTO theme_versions(id,version,digest,prefix,manifest_json,installed_at) VALUES(?,?,?,?,?,?)').bind('builtin-check', '1.0.0', 'a'.repeat(64), prefix, JSON.stringify(manifest), 1).run();
  await (await mf.getR2Bucket('THEMES')).put(prefix + '/index.html', '<html></html>');
  config.pages.monitor.theme = { short: 'builtin-check', version: '1.0.0', theme: 'monitor' };
  config.pages.monitor.themeOptions = { accent: '#123456' };
  await save();
  assert.equal(config.pages.monitor.headCode, undefined);
  assert.equal(config.pages.monitor.contentHtml, undefined);
  config.pages.monitor.headCode = '<script>window.installed=true</script>';
  config.pages.monitor.contentHtml = '<p>Installed content</p>';
  await save();
  const installed = (await publicConfig('monitor')).body;
  assert.equal(installed.theme_head_code, null);
  assert.equal(installed.theme_content_html, config.pages.monitor.contentHtml);
  assert.deepEqual(installed.theme_settings, { accent: '#123456' });
  config.pages.monitor.theme = null;
  await save();
  assert.deepEqual(config.pages.monitor.themeOptions, {});
  assert.equal(config.pages.monitor.headCode, undefined);
  assert.equal(config.pages.monitor.contentHtml, undefined);
  const restored = (await publicConfig('monitor')).body;
  for (const [key, value] of Object.entries(fixture.defaults.monitor)) assert.equal(restored.presentation[key], value);
  assert.equal(restored.theme_settings, null);
  console.log('PASS built-in shared contract, Worker options/injections, privacy, strict validation and theme switching');
} finally { await mf.dispose(); }
