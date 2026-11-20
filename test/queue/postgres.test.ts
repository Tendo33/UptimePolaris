import assert from 'node:assert/strict';
import postgres from 'postgres';
import { Miniflare } from 'miniflare';
import { readFileSync, readdirSync } from 'node:fs';
import { PostgresAdapter } from '../../backends/worker/src/lib/db/postgres';
import { withDBScope } from '../../backends/worker/src/lib/db/factory';
import { queueScenario, queueEdgeScenario } from './runtime.test';
import { migrateDataWithConnection } from '../../backends/worker/src/lib/db/data-migration';
import { BOOTSTRAP_FILES } from '../../backends/worker/src/lib/db/schema-bootstrap';
import { INITIAL_QUEUE_JSON } from '../../backends/worker/src/lib/queue/control';
import type { Env } from '../../backends/worker/src/types';
const port = Number(process.env.AI_TEST_PG_PORT);
assert.ok(Number.isInteger(port) && port > 0);
const base = `postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable`, admin = postgres(base, { max: 1, onnotice() { } }), names: string[] = [];
const create = async () => { const name = 'queue_' + crypto.randomUUID().replaceAll('-', ''); await admin.unsafe(`CREATE DATABASE ${name}`); names.push(name); return base.replace('/postgres?', `/${name}?`); };
const mf = new Miniflare({ modules: true, script: 'export default {fetch(){return new Response("fixture")}}', compatibilityDate: '2025-01-01', kvNamespaces: { CONFIG: crypto.randomUUID() }, d1Databases: { DB: crypto.randomUUID() } });
try {
  const url = await create(), sql = postgres(url, { max: 1, onnotice() { } });
  try {
    for (const file of readdirSync('database/schema/postgres').filter(f => f.endsWith('.postgres.sql')).sort()) {
      if (file.startsWith('0028'))
        await sql `INSERT INTO monitors(id,name,type,target,created_at,updated_at) VALUES('retained','Retained','http','https://native.example',1,1)`;
      await sql.unsafe(readFileSync(`database/schema/postgres/${file}`, 'utf8'));
      await sql `INSERT INTO schema_migrations(name,applied_at) VALUES(${file},1)`;
    }
    assert.equal((await sql `SELECT id FROM monitors WHERE id='retained'`).length, 1);
    assert.equal((await sql `SELECT json FROM check_queue_control`)[0].json, INITIAL_QUEUE_JSON);
    const db = new PostgresAdapter(url);
    try {
      const env = { DATABASE_TYPE: 'postgres', DATABASE_URL: url, CONFIG: await mf.getKVNamespace('CONFIG'), ADMIN_TOKEN: 'fixture-queue-material' } as Env;
      if (!process.env.QUEUE_EDGES_ONLY)
        await withDBScope(env, scoped => queueScenario(scoped, db));
      await withDBScope(env, scoped => queueEdgeScenario(scoped, db));
    }
    finally {
      await db.close();
    }
  }
  finally {
    await sql.end();
  }
  const source = await mf.getD1Database('DB');
  for (const migration of BOOTSTRAP_FILES)
    if (migration.statements.length)
      await source.batch(migration.statements.map(s => source.prepare(s)));
  for (const initialized of [false, true]) {
    const target = postgres(await create(), { max: 1, onnotice() { } });
    try {
      if (initialized)
        for (const file of readdirSync('database/schema/postgres').filter(f => f.endsWith('.postgres.sql')).sort()) {
          await target.unsafe(readFileSync(`database/schema/postgres/${file}`, 'utf8'));
          await target `INSERT INTO schema_migrations(name,applied_at) VALUES(${file},1)`;
        }
      await migrateDataWithConnection(source, target, true);
      const rows = await target `SELECT * FROM check_queue_control`;
      assert.equal(rows.length, 1);
      assert.equal(rows[0].json, INITIAL_QUEUE_JSON);
      assert.equal(rows[0].revision, 'initial');
      await target `UPDATE check_queue_control SET revision='user-change'`;
      await assert.rejects(() => migrateDataWithConnection(source, target, true), /target_not_empty/);
    }
    finally {
      await target.end();
    }
  }
  console.log('PASS Queue PostgreSQL upgrade and D1→PG copy: fresh/preinitialized default singleton, nondefault target rejected');
}
finally {
  await mf.dispose();
  for (const name of names)
    await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
}
