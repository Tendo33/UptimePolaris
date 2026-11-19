import assert from 'node:assert/strict';
import postgres from 'postgres';
import { Miniflare } from 'miniflare';
import { readFileSync,readdirSync } from 'node:fs';
import { PostgresAdapter } from '../../backends/worker/src/lib/db/postgres';
import { runtimeScenario } from './runtime-worker.test';
import { migrateDataWithConnection } from '../../backends/worker/src/lib/db/data-migration';
import { BOOTSTRAP_FILES } from '../../backends/worker/src/lib/db/schema-bootstrap';
import { AiStore } from '../../backends/worker/src/lib/ai/store';
import { D1Adapter } from '../../backends/worker/src/lib/db/d1';
import { decryptAiCredential } from '../../backends/worker/src/lib/ai/credentials';
import type { Env } from '../../backends/worker/src/types';

const port=Number(process.env.AI_TEST_PG_PORT);assert.ok(Number.isInteger(port)&&port>0);
const base=`postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,admin=postgres(base,{max:1,onnotice(){}}),name=`ai_runtime_${crypto.randomUUID().replaceAll('-','')}`;
const mf=new Miniflare({modules:true,script:'export default {fetch(){return new Response("fixture")}}',compatibilityDate:'2025-01-01',kvNamespaces:{CONFIG:crypto.randomUUID()},d1Databases:{DB:crypto.randomUUID()}});
let created=false;
try{
  await admin.unsafe(`CREATE DATABASE ${name}`);created=true;const url=base.replace('/postgres?',`/${name}?`),sql=postgres(url,{max:1,onnotice(){}});
  try{
    for(const file of readdirSync('database/schema/postgres').filter(file=>file.endsWith('.postgres.sql')).sort()){
      await sql.unsafe(readFileSync(`database/schema/postgres/${file}`,'utf8'));await sql`INSERT INTO schema_migrations(name,applied_at) VALUES(${file},1)`;
    }
    const db=new PostgresAdapter(url);try{if(process.env.AI_TEST_COPY_ONLY!=='true')await runtimeScenario({DATABASE_TYPE:'postgres',DATABASE_URL:url,CONFIG:await mf.getKVNamespace('CONFIG'),ADMIN_TOKEN:'fixture-runtime-material'} as Env,db);}finally{await db.close();}
  }finally{await sql.end();}
  const migrationName=`ai_copy_${crypto.randomUUID().replaceAll('-','')}`;await admin.unsafe(`CREATE DATABASE ${migrationName}`);
  const target=postgres(base.replace('/postgres?',`/${migrationName}?`),{max:1,onnotice(){}});
  try{
    const source=await mf.getD1Database('DB');for(const file of BOOTSTRAP_FILES)if(file.statements.length)await source.batch(file.statements.map(statement=>source.prepare(statement)));
    const sourceStore=new AiStore(new D1Adapter(source)),channel=await sourceStore.saveChannel({name:'Migration fixture',baseUrl:'https://provider.example/v1',protocol:'openai',apiKey:'fixture-migration-key'},'fixture-migration-material');
    await sourceStore.saveModel({channelId:channel.id,name:'Migration model',modelId:'migration-model',enabled:true,isPublic:false,intervalSec:300,timeoutMs:1000});
    await migrateDataWithConnection(source,target,true);
    const [row]=await target`SELECT credential_ciphertext FROM ai_channels WHERE id=${channel.id}`;assert.equal(await decryptAiCredential(row.credential_ciphertext,channel.id,'fixture-migration-material'),'fixture-migration-key');
    assert.equal((await target`SELECT id FROM ai_runtime`).length,1);assert.equal((await target`SELECT id FROM ai_models`).length,1);
    console.log('PASS AI D1 to PostgreSQL copy: FK order, encrypted credentials and singleton bootstrap state');
  }finally{await target.end();await admin.unsafe(`DROP DATABASE ${migrationName} WITH (FORCE)`);}
}finally{await mf.dispose();if(created)await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);await admin.end();}
