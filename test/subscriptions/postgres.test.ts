import assert from 'node:assert/strict';
import postgres from 'postgres';
import { readFileSync, readdirSync } from 'node:fs';

const port = Number(process.env.AI_TEST_PG_PORT);
assert.ok(Number.isInteger(port) && port > 0);
const base = `postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable`;
const admin = postgres(base, { max: 1 });
const name = `subscriptions_${crypto.randomUUID().replaceAll('-', '')}`;
await admin.unsafe(`CREATE DATABASE ${name}`);
const url = base.replace('/postgres?', `/${name}?`), sql = postgres(url, { max: 1 });
try {
  for (const file of readdirSync('database/schema/postgres').filter(file => file.endsWith('.postgres.sql')).sort()) {
    await sql.unsafe(readFileSync(`database/schema/postgres/${file}`, 'utf8'));
    await sql`INSERT INTO schema_migrations(name,applied_at) VALUES(${file},${Math.floor(Date.now()/1000)})`;
  }
  process.env.SUBSCRIPTION_TEST_POSTGRES_URL = url;
  await import('./worker.test');
} finally {
  await sql.end();
  await admin.unsafe(`DROP DATABASE ${name} WITH (FORCE)`);
  await admin.end();
}
