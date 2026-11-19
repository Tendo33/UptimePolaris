import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('artifacts/tmp',{recursive:true});
const outfile='artifacts/tmp/queue-runtime.mjs';
await build({entryPoints:['test/queue/runtime.test.ts'],outfile,bundle:true,platform:'node',format:'esm',packages:'external',plugins:[{name:'socket',setup(b){b.onResolve({filter:/^cloudflare:sockets$/},()=>({path:'socket',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export function connect(){throw new Error("unexpected socket")}' }));}}]});
execFileSync(process.execPath,[outfile],{stdio:'inherit',windowsHide:true});

await build({entryPoints:['backends/worker/src/lib/db/schema-bootstrap.ts'],outfile:'artifacts/tmp/queue-schema.mjs',bundle:true,format:'esm',platform:'node'});
execFileSync(process.execPath,['test/queue/miniflare.test.mjs'],{stdio:'inherit',windowsHide:true});
