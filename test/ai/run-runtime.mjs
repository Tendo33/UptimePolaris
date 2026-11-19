import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
mkdirSync('artifacts/tmp',{recursive:true});
const output='artifacts/tmp/ai-runtime-worker.mjs';
await build({entryPoints:['test/ai/runtime-worker.test.ts'],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',plugins:[{name:'worker-socket',setup(b){b.onResolve({filter:/^cloudflare:sockets$/},()=>({path:'socket',namespace:'fixture'}));b.onLoad({filter:/.*/,namespace:'fixture'},()=>({contents:'export function connect(){throw new Error("unexpected socket")}' }));}}]});
execFileSync(process.execPath,[output],{stdio:'inherit',windowsHide:true});
