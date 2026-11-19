import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join, sep } from 'node:path';
import net from 'node:net';
import { build } from 'esbuild';

const base = resolve('artifacts/tmp/ai-postgres');
mkdirSync(base, { recursive: true });
const root = mkdtempSync(join(base, 'owned-')), data = join(root, 'data'), marker = join(root, 'owner'), owner = randomUUID();
writeFileSync(marker, owner, { flag: 'wx' });
const find = name => execFileSync(process.platform === 'win32' ? 'where.exe' : 'which', [name], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
const initdb = find('initdb'), pgctl = find('pg_ctl');
const listener = net.createServer();
await new Promise((ok, fail) => listener.once('error', fail).listen(0, '127.0.0.1', ok));
const port = listener.address().port;
await new Promise((ok, fail) => listener.close(error => error ? fail(error) : ok()));
let attempted = false;
try {
  execFileSync(initdb, ['-D', data, '-U', 'postgres', '--auth=trust', '--no-locale', '--encoding=UTF8'], { stdio: 'inherit', windowsHide: true });
  attempted = true;
  execFileSync(pgctl, ['-D', data, '-l', join(root, 'postgres.log'), '-o', `-h 127.0.0.1 -p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories=`, '-w', 'start'], { stdio: 'inherit', windowsHide: true });
  const outfile = join(root, 'worker.mjs');
  const runtime=process.argv.includes('--runtime'),queue=process.argv.includes('--queue'),subscriptions=process.argv.includes('--subscriptions');
  await build({ entryPoints: [subscriptions?'test/subscriptions/postgres.test.ts':queue?'test/queue/postgres.test.ts':runtime?'test/ai/runtime-postgres.test.ts':'test/ai/management-postgres.test.ts'], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external',
    plugins: [{ name: 'worker-socket', setup(b) {
      b.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'socket', namespace: 'fixture' }));
      b.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function connect(){throw new Error("unexpected socket")}' }));
    } }],
  });
  execFileSync(process.execPath, [outfile], { stdio: 'inherit', windowsHide: true, env: { ...process.env, AI_TEST_DRIVER: 'postgres', AI_TEST_PG_PORT: String(port),AI_TEST_COPY_ONLY:process.argv.includes('--copy-only')?'true':'' } });
  if(!queue)execFileSync('go', ['-C', 'backends/go', 'test', './internal/polaris', '-run', subscriptions?'^TestSubscriptionPostgres$':runtime?'^TestAIRuntimePostgres$':'^TestAIManagementPostgres$', '-count=1', '-v'], {
    stdio: 'inherit', windowsHide: true, env: { ...process.env, POLARIS_TEST_POSTGRES_URL: `postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable` },
  });
} finally {
  assert.ok(realpathSync(root).startsWith(realpathSync(base)+sep));
  assert.equal(readFileSync(marker, 'utf8'), owner);
  if (attempted) {
    const status = spawnSync(pgctl, ['-D', data, 'status'], { encoding: 'utf8', windowsHide: true });
    if (status.status === 0) {
      const pid = readFileSync(join(data, 'postmaster.pid'), 'utf8').split(/\r?\n/);
      assert.equal(resolve(pid[1]), resolve(data)); assert.equal(Number(pid[3]), port);
      execFileSync(pgctl, ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'inherit', windowsHide: true });
    } else if (existsSync(join(data, 'postmaster.pid'))) throw new Error('Unresolved owned PostgreSQL process');
  }
  console.log(`Owned fixture retained: ${root}`);
}
