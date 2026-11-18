import assert from 'node:assert/strict';
import { asReportParams } from '../../backends/worker/src/lib/agent/protocol';
import { writeAgentHistory } from '../../backends/worker/src/lib/agent/history';
import { setupRequirements } from '../../backends/worker/src/lib/auth/setup-requirements';
import type { Env } from '../../backends/worker/src/types';

const frame = {
  cpu: { usage: 17 }, ram: { total: 100, used: 35 }, swap: { total: 0, used: 0 },
  load: { load1: null, load5: null, load15: null }, disk: { total: 100, used: 20 },
  network: { up: 3, down: 7, totalUp: 100, totalDown: 200 },
  connections: { tcp: null, udp: 0 }, process: null, uptime: 100,
  observed_at: 180, summaries: [], interfaces: null, mounts: null, message: '',
};
const parsed = asReportParams(frame)!;
assert.ok(parsed);
assert.deepEqual(parsed.load, frame.load);
assert.deepEqual(parsed.connections, frame.connections);
assert.equal(parsed.process, null);
const sent: Parameters<AnalyticsEngineDataset['writeDataPoint']>[0][] = [];
const env = { UPTIME: { writeDataPoint: (point) => sent.push(point) } } as unknown as Env;
writeAgentHistory(env, 'metric-fixture', parsed, 180);
assert.equal(sent[0].doubles![6], -1);
assert.equal(sent[0].doubles![15], -1);
assert.equal(sent[0].doubles![16], 0);
assert.equal(sent[0].doubles![17], -1);
for (const invalid of [undefined, -1, '0', NaN]) {
  assert.equal(asReportParams({ ...frame, load: { ...frame.load, load1: invalid } }), null);
  assert.equal(asReportParams({ ...frame, connections: { ...frame.connections, tcp: invalid } }), null);
  assert.equal(asReportParams({ ...frame, process: invalid }), null);
}
assert.deepEqual(setupRequirements(env).find(item => item.key === 'analyticsSql'), { key: 'analyticsSql', required: false, ok: false });
assert.equal(setupRequirements({ ...env, ANALYTICS_SQL: { query: async () => ({ data: [] }) } as unknown as AnalyticsSQLBinding }).find(item => item.key === 'analyticsSql')?.ok, true);
console.log('PASS nullable Agent runtime metrics, AE missing-value sentinels and history binding detection');
