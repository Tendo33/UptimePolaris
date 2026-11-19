import assert from 'node:assert/strict';
import postgres from 'postgres';
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import { workerApiScenario } from './management-worker.test';
import { AiStore } from '../../backends/worker/src/lib/ai/store';
import { PostgresAdapter } from '../../backends/worker/src/lib/db/postgres';
import { api } from '../../backends/worker/src/api';
import type { Env } from '../../backends/worker/src/types';
import { verifyProtocolUpgrade } from './protocol-upgrade';

const port = Number(process.env.AI_TEST_PG_PORT);
assert.ok(Number.isInteger(port) && port > 0);
const base = `postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
const admin = postgres(base, { max: 1 });
const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2025-01-01', kvNamespaces: { CONFIG: crypto.randomUUID(), FRESH: crypto.randomUUID() } });
const names: string[] = [];
try {
  for (const fresh of [false, true]) {
    const name = `ai_worker_${crypto.randomUUID().replaceAll('-', '')}`;
    names.push(name);
    await admin.unsafe(`CREATE DATABASE ${name}`);
    const url = base.replace('/postgres?', `/${name}?`), sql = postgres(url, { max: 1 });
    try {
      const files = readdirSync('database/schema/postgres').filter(file => file.endsWith('.postgres.sql')).sort();
      for (const file of fresh ? files : files.filter(file => file < '0026')) {
        await sql.unsafe(readFileSync(`database/schema/postgres/${file}`, 'utf8'));
        await sql`INSERT INTO schema_migrations(name,applied_at) VALUES(${file},${Math.floor(Date.now()/1000)})`;
      }
      const adapter = new PostgresAdapter(url);
      try {
        if (!fresh) {
          await sql`INSERT INTO monitor_groups(id,name,created_at,updated_at) VALUES('retained','Retained',1,1)`;
          await assert.rejects(() => new AiStore(adapter).channels(), /does not exist/);
          await sql.begin(async tx => {
            for (const file of files.filter(file => file >= '0026' && file < '0029')) {
              await tx.unsafe(readFileSync(`database/schema/postgres/${file}`, 'utf8'));
              await tx`INSERT INTO schema_migrations(name,applied_at) VALUES(${file},1)`;
            }
          });
          await verifyProtocolUpgrade(adapter, async () => {
            await sql.begin(async tx => {
              for (const file of files.filter(file => file >= '0029')) {
                await tx.unsafe(readFileSync(`database/schema/postgres/${file}`, 'utf8'));
                await tx`INSERT INTO schema_migrations(name,applied_at) VALUES(${file},1)`;
              }
            });
          });
          assert.equal((await sql`SELECT id FROM monitor_groups WHERE id='retained'`).length, 1);
        }
        assert.deepEqual(await new AiStore(adapter).channels(), []);
      } finally { await adapter.close(); }
      if (!fresh) {
        const env = { DATABASE_TYPE: 'postgres', DATABASE_URL: url, CONFIG: await mf.getKVNamespace('CONFIG'), ADMIN_TOKEN: 'fixture-ai-installation-key', PBKDF2_ITERATIONS: '3000', UPTIME: { writeDataPoint() {} } } as Env;
        await workerApiScenario(env, async id => (await sql`SELECT credential_ciphertext FROM ai_channels WHERE id=${id}`)[0].credential_ciphertext);
      }
      console.log(`PASS AI Worker PostgreSQL ${fresh ? 'fresh schema' : 'upgrade and complete management API contract'}`);
    } finally { await sql.end(); }
  }
} finally {
  await mf.dispose();
  for (const name of names) await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
}
