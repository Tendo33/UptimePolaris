import assert from 'node:assert/strict';
import { AiStore } from '../../backends/worker/src/lib/ai/store';
import type { DBAdapter } from '../../backends/worker/src/lib/db/adapter';
import { encryptAiCredential } from '../../backends/worker/src/lib/ai/credentials';

export async function verifyProtocolUpgrade(db: DBAdapter, upgrade: () => Promise<void>) {
  const store = new AiStore(db);
  const channel = { id: crypto.randomUUID(), revision: crypto.randomUUID() }, model = { id: crypto.randomUUID(), revision: crypto.randomUUID() };
  await db.execute(store.sql('INSERT INTO ai_channels(id,name,base_url,protocol,credential_ciphertext,revision,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)'), [channel.id, 'Protocol upgrade fixture', 'https://provider.example/v1', 'openai', await encryptAiCredential('upgrade-fixture-key', channel.id, 'upgrade-fixture-material'), channel.revision, 1, 2]);
  await db.execute(store.sql('INSERT INTO ai_models(id,channel_id,name,model_id,interval_sec,timeout_ms,enabled,is_public,revision,created_at,updated_at,notification_channel_ids) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)'), [model.id, channel.id, 'Retained model', 'fixture/model', 300, 1000, 0, 1, model.revision, 1, 2, '["retained-notification"]']);
  const days = JSON.stringify([{ date: '2026-11-17', total: 3, ok: 2, availabilityPct: 200 / 3, avgLatencyMs: 20, exact: true }]);
  await db.execute(store.sql('INSERT INTO ai_daily(model_id,days_json) VALUES(?,?)'), [model.id, days]);
  const selects = ['SELECT id,name,base_url,protocol,credential_ciphertext,revision,created_at,updated_at FROM ai_channels', 'SELECT id,channel_id,name,model_id,interval_sec,timeout_ms,enabled,is_public,revision,created_at,updated_at FROM ai_models', 'SELECT * FROM ai_daily', 'SELECT * FROM ai_runtime'];
  const before = await Promise.all(selects.map(query => db.query(query)));
  await upgrade();
  const after = await Promise.all(selects.map(query => db.query(query)));
  assert.deepEqual(after, before, 'protocol migration preserves linked models, credentials, history and versions');
  await store.remove('channels', channel.id, channel.revision);
  assert.deepEqual(await store.models(), []);
  assert.equal((await db.query('SELECT * FROM ai_daily')).length, 0, 'cascade survives protocol migration');
}
