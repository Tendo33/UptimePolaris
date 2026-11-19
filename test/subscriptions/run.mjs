import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

mkdirSync('artifacts/tmp', { recursive: true });
for (const name of process.argv[2] ? [process.argv[2]] : ['descriptor', 'fetch', 'destination', 'runtime', 'pagination', 'cache', 'worker']) {
  const outfile = `artifacts/tmp/subscription-${name}.mjs`;
  await build({ entryPoints: [`test/subscriptions/${name}.test.ts`], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', plugins: [{ name: 'worker-socket', setup(builder) {
    builder.onResolve({ filter: /^cloudflare:sockets$/ }, () => ({ path: 'socket', namespace: 'fixture' }));
    builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({ contents: 'export function connect(){throw new Error("unexpected socket")}' }));
  } }] });
  execFileSync(process.execPath, [outfile], { stdio: 'inherit', windowsHide: true });
}
if (!process.argv[2]) execFileSync(process.execPath, ['test/subscriptions/egress.test.mjs'], { stdio: 'inherit', windowsHide: true });
