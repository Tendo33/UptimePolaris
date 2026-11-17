#!/usr/bin/env node
// 一条命令生成宣传截图：启动夹具与 Go 后端、灌演示数据、截图、回收。
// One command for promotion screenshots: start the fixtures and the Go backend, seed the demo
// data, capture the pages, then clean up.

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const outDir = process.env.PROMO_OUT ?? join(root, 'promo-screenshots');
const dataDir = await mkdtemp(join(tmpdir(), 'polaris-promo-data-'));
const profileDir = await mkdtemp(join(tmpdir(), 'polaris-promo-chrome-'));
const binary = process.argv[2] ?? join(root, 'artifacts', 'tmp', 'polaris-promo.exe');
const httpPort = 18081;
const tcpPort = 18082;
const appPort = 18080;
const base = `http://127.0.0.1:${appPort}`;
const setupKey = 'promo-setup-key';
const username = 'admin';
const password = 'promo-password-123';
await mkdir(outDir, { recursive: true });

// --- fixtures ---------------------------------------------------------------
const fixtureHttp = createServer((request, response) => {
  const path = new URL(request.url ?? '/', 'http://fixture').pathname;
  setTimeout(() => {
    if (path === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ ok: true, version: '0.1.0' }));
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end('<!doctype html><title>fixture</title><p>ok</p>');
  }, path === '/slow' ? 900 : 0);
});
await new Promise((done) => fixtureHttp.listen(httpPort, '127.0.0.1', done));
// 探测端读完就会关闭连接，服务端的 ECONNRESET 属于正常现象。
// The probe closes the connection after reading; a server-side ECONNRESET is expected.
const fixtureTcp = createTcpServer((socket) => {
  socket.on('error', () => {});
  socket.end('+PONG\r\n');
});
await new Promise((done) => fixtureTcp.listen(tcpPort, '127.0.0.1', done));

// --- backend ----------------------------------------------------------------
const backend = spawn(binary, ['--addr', `127.0.0.1:${appPort}`, '--data-dir', dataDir, '--frontend-dir', join(root, 'public')], {
  env: { ...process.env, POLARIS_SETUP_KEY: setupKey },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let backendLog = '';
backend.stdout.on('data', (chunk) => { backendLog += chunk; });
backend.stderr.on('data', (chunk) => { backendLog += chunk; });
for (let i = 0; i < 100; i++) {
  try { await fetch(`${base}/api/auth/session`); break; } catch { await new Promise((r) => setTimeout(r, 150)); }
}

// --- seed -------------------------------------------------------------------
async function call(path, { method = 'GET', body, cookie } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (cookie) headers.cookie = cookie;
  const response = await fetch(`${base}${path}`, { method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (!response.ok) throw new Error(`${method} ${path} -> ${response.status}: ${(await response.text()).slice(0, 160)}`);
  return response.json();
}

await call('/api/auth/setup', { method: 'POST', body: { credential: setupKey, username, password, database: { type: 'sqlite' } } });
const login = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
const cookie = login.headers.get('set-cookie').split(';')[0];

const groups = {};
for (const [key, name, weight] of [['production', 'Production', 10], ['edge', 'Edge network', 20], ['internal', 'Internal services', 30]]) {
  groups[key] = (await call('/api/groups', { method: 'POST', cookie, body: { name, weight } })).id;
}
const tags = {};
for (const [key, name, color] of [['critical', 'critical', '#EF4444'], ['api', 'api', '#8B5CF6'], ['database', 'database', '#F59E0B'], ['edge', 'edge', '#0EA5E9'], ['backup', 'backup', '#10B981']]) {
  tags[key] = (await call('/api/tags', { method: 'POST', cookie, body: { name, color } })).id;
}

const fixture = `http://127.0.0.1:${httpPort}`;
const monitors = [
  { key: 'site', name: 'Main website', type: 'http', target: `${fixture}/`, group: 'production', tags: ['critical', 'api'] },
  { key: 'api', name: 'API gateway', type: 'http', target: `${fixture}/api/health`, group: 'production', tags: ['api', 'critical'] },
  { key: 'docs', name: 'Documentation', type: 'http', target: `${fixture}/docs`, interval_sec: 300, group: 'production', tags: ['api'] },
  { key: 'db', name: 'PostgreSQL 5432', type: 'tcp', target: `127.0.0.1:${tcpPort}`, group: 'internal', tags: ['database'] },
  { key: 'redis', name: 'Redis 6379', type: 'tcp', target: `127.0.0.1:${tcpPort}`, group: 'internal', tags: ['database'] },
  { key: 'backup', name: 'Nightly backup', type: 'push', target: '', interval_sec: 86400, group: 'internal', tags: ['backup'] },
  { key: 'dns', name: 'DNS resolution', type: 'dns', target: 'example.com', interval_sec: 300, group: 'edge', tags: ['edge'], options_json: { dns: { recordType: 'A' } } },
  { key: 'tls', name: 'TLS handshake', type: 'tls', target: 'example.com:443', interval_sec: 300, group: 'edge', tags: ['edge'] },
];
const created = [];
for (const monitor of monitors) {
  const { key, group, tags: tagKeys, ...body } = monitor;
  const row = await call('/api/monitors', {
    method: 'POST', cookie,
    body: { interval_sec: 60, ...body, group_id: groups[group], tag_ids: tagKeys.map((tag) => tags[tag]) },
  });
  created.push({ key, id: row.id, push: row.push_token });
}

await call('/api/admin/settings', {
  method: 'PUT', cookie,
  body: { 'site.description': 'Service availability and host monitoring' },
});

const presentation = await call('/api/admin/presentation', { cookie });
await call('/api/admin/presentation', {
  method: 'PUT', cookie,
  body: { revision: presentation.revision, config: { ...presentation.config, agentEnabled: true } },
});

const now = Math.floor(Date.now() / 1000);
const fleet = [
  { name: 'hk-edge-01', region: 'Hong Kong, CN', cpu: 18.4, mem: 38, disk: 41, load: 0.42, up: 1_200_000, down: 4_800_000 },
  { name: 'sg-core-02', region: 'Singapore, SG', cpu: 47.9, mem: 56, disk: 44, load: 1.31, up: 3_400_000, down: 11_200_000 },
  { name: 'fra-db-01', region: 'Frankfurt, DE', cpu: 72.1, mem: 80, disk: 61, load: 2.14, up: 900_000, down: 2_100_000 },
];
for (const machine of fleet) {
  const agent = await call('/api/admin/agents', { method: 'POST', cookie, body: { name: machine.name, is_public: true } });
  await call(`/api/admin/agents/${agent.id}/probe`, { method: 'POST', cookie, body: { enabled: true } }).catch(() => {});
  const memTotal = 16 * 1024 ** 3;
  const diskTotal = 200 * 1024 ** 3;
  const frames = [
    {
      jsonrpc: '2.0', id: 1, method: 'basicReport',
      params: {
        name: machine.name, os: 'linux', arch: 'x86_64', kernel: '6.8.0-polaris', cpu_model: 'AMD EPYC 7B13',
        cpu_cores: 8, mem_total: memTotal, version: '0.1.0', transport: 'http', report_interval_secs: 60,
        capabilities: [], isp: 'Demo provider', region: machine.region, virtualization: 'kvm',
      },
    },
    {
      jsonrpc: '2.0', id: null, method: 'report',
      params: {
        interfaces: [{ name: 'eth0', up_rate: machine.up, down_rate: machine.down, total_up_bytes: 1.2e12, total_down_bytes: 4.8e12 }],
        mounts: [{
          name: '/', total_bytes: diskTotal, used_bytes: Math.round(machine.disk / 100 * diskTotal),
          free_bytes: Math.round((1 - machine.disk / 100) * diskTotal), used_percent: machine.disk,
        }],
        observed_at: now,
        summaries: Array.from({ length: 8 }, (_, index) => ({
          bucket_ts: Math.floor((now - index * 60) / 60) * 60,
          sample_count: 12, cpu_samples: 12, mem_samples: 12,
          cpu_avg: machine.cpu + Math.sin(index) * 6, cpu_max: machine.cpu + 9,
          mem_pct_avg: machine.mem + Math.cos(index) * 3, mem_pct_max: machine.mem + 5,
          load_1_avg: machine.load, load_5_avg: machine.load * 0.8,
          net_up_bytes: machine.up * 60, net_down_bytes: machine.down * 60,
          duration_sec: 60, network_duration_sec: 60,
        })),
        cpu: { usage: machine.cpu },
        ram: { total: memTotal, used: machine.mem / 100 * memTotal },
        swap: { total: 2 * 1024 ** 3, used: 0 },
        load: { load1: machine.load, load5: machine.load * 0.8, load15: machine.load * 0.6 },
        disk: { total: diskTotal, used: machine.disk / 100 * diskTotal },
        network: { up: machine.up, down: machine.down, totalUp: 1.2e12, totalDown: 4.8e12 },
        connections: { tcp: 128, udp: 14 },
        uptime: 864000, process: 184, message: '',
      },
    },
  ];
  const push = await fetch(`${base}/api/public/agent/push/${agent.token}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(frames),
  });
  if (!push.ok) console.log(`agent ${machine.name} -> ${push.status}: ${(await push.text()).slice(0, 120)}`);
}

const backup = created.find((monitor) => monitor.key === 'backup');
if (backup?.push) {
  await fetch(`${base}/api/public/push/${backup.id}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${backup.push}` },
    body: JSON.stringify({ status: 1, message: 'backup completed in 41s' }),
  });
}

// 历史读数：可用率与趋势图从 polaris_readings 聚合，演示实例需要一天的回填数据。
// Historical readings: availability and trend charts aggregate polaris_readings.
const { DatabaseSync } = await import('node:sqlite');
const db = new DatabaseSync(join(dataDir, 'polaris.sqlite'));
const insert = db.prepare('INSERT INTO polaris_readings(monitor_id,ts,status,value,code,message,addons) VALUES(?,?,?,?,?,?,?)');
const baseLatency = { site: 142, api: 128, docs: 216, db: 9, redis: 6 };
db.exec('BEGIN');
let rows = 0;
for (const monitor of created) {
  for (let minute = 1; minute <= 1440; minute += 1) {
    if (monitor.key === 'backup' && minute % 60 !== 0) continue;
    const jitter = Math.sin(minute / 7 + monitor.key.length) * 0.12;
    const latency = baseLatency[monitor.key];
    insert.run(monitor.id, now - minute * 60, 1, latency ? Math.max(1, Math.round(latency * (1 + jitter))) : 0, 200, '', '[]');
    rows += 1;
  }
}
db.exec('COMMIT');
db.close();
console.log(`seeded ${created.length} monitors, ${fleet.length} agents, ${rows} readings`);

// --- screenshots ------------------------------------------------------------
const chrome = (await Promise.all([
  process.env.CHROME_BIN,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
].filter(Boolean).map(async (path) => [path, await stat(path).then(() => true).catch(() => false)])))
  .find(([, ok]) => ok)?.[0];
if (!chrome) throw new Error('Chrome not found; set CHROME_BIN');

const browser = spawn(chrome, [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--disable-gpu',
  '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1600,1000',
  '--remote-debugging-port=0', `--user-data-dir=${profileDir}`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'ignore'] });

let debugPort;
for (let i = 0; i < 600 && browser.exitCode === null; i++) {
  try { debugPort = Number((await readFile(join(profileDir, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); break; }
  catch { await new Promise((r) => setTimeout(r, 100)); }
}
if (!debugPort) throw new Error(`Chrome did not start (exit ${browser.exitCode}): ${backendLog.slice(-400)}`);

const target = await fetch(`http://127.0.0.1:${debugPort}/json/new?about:blank`, { method: 'PUT' }).then((r) => r.json());
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok, fail) => { socket.addEventListener('open', ok, { once: true }); socket.addEventListener('error', fail, { once: true }); });
let sequence = 0;
const waiting = new Map();
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (!message.id) return;
  const handler = waiting.get(message.id);
  if (!handler) return;
  waiting.delete(message.id);
  message.error ? handler.reject(new Error(message.error.message)) : handler.resolve(message.result);
});
const cdp = (method, params = {}) => new Promise((resolveCall, reject) => {
  const id = ++sequence;
  waiting.set(id, { resolve: resolveCall, reject });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => (await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
await cdp('Page.enable');
await cdp('Runtime.enable');

const waitFor = async (expression, label, timeout = 30_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try { if (await evaluate(expression)) return; } catch { }
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error(`timed out: ${label}`);
};
const shot = async (name) => {
  const { data } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  await writeFile(join(outDir, `${name}.png`), Buffer.from(data, 'base64'));
  console.log(`shot ${name}`);
};
const visit = async (path, ready) => {
  await cdp('Page.navigate', { url: `${base}${path}` });
  if (ready) await waitFor(ready, path);
  await new Promise((r) => setTimeout(r, 2200));
};

try {
  await visit('/login', `!!document.querySelector('input[autocomplete=username]')`);
  // 展示一套已在运行的实例：固定语言与主题，并隐藏入门卡。
  // Show an instance that is already running: fixed locale and theme, onboarding dismissed.
  await evaluate(`localStorage.setItem('uptime-polaris-locale','en-US'); localStorage.setItem('theme','light'); localStorage.setItem('uptime-polaris.console.onboardingDismissed','1')`);
  await evaluate(`fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:${JSON.stringify(username)},password:${JSON.stringify(password)}})}).then(r=>r.status)`);
  await new Promise((r) => setTimeout(r, 1200));

  await visit('/', `document.body.innerText.includes('Main website')`);
  await shot('01-public-status-page');
  await visit('/admin', `document.body.innerText.includes('Main website')`);
  await shot('02-console-overview');
  await visit('/admin/agents', `document.body.innerText.includes('hk-edge-01')`);
  await shot('03-console-agents');
  await visit('/admin/groups', `document.body.innerText.includes('Production')`);
  await shot('04-console-groups');
  await visit('/admin/notifications', `document.body.innerText.includes('Notifications')`);
  await shot('05-console-notifications');
  await visit('/admin/themes', `document.body.innerText.includes('Themes')`);
  await shot('06-console-themes');
  await visit('/admin/settings', `document.body.innerText.includes('Settings')`);
  await shot('07-console-settings');
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 2, mobile: false });
  await visit('/', `document.body.innerText.includes('Main website')`);
  await shot('08-public-status-page-1440');
  socket.send(JSON.stringify({ id: ++sequence, method: 'Browser.close' }));
  await new Promise((r) => setTimeout(r, 1200));
} finally {
  if (browser.exitCode === null) browser.kill();
  backend.kill();
  fixtureHttp.close();
  fixtureTcp.close();
  await new Promise((r) => setTimeout(r, 1200));
  await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  await rm(dataDir, { recursive: true, force: true }).catch(() => {});
  console.log(`screenshots in ${outDir}`);
}
