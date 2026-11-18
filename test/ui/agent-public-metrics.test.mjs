import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('../../frontend/node_modules/esbuild');
const React = require('../../frontend/node_modules/react');
const { renderToStaticMarkup } = require('../../frontend/node_modules/react-dom/server');
const clsx = require('../../frontend/node_modules/clsx');
const compile = (file, name, env = {}) => {
  const source = readFileSync(`frontend/src/components/agent/${file}`, 'utf8')
    .replace(/^import[\s\S]*?;\r?\n/gm, '').replaceAll('export ', '');
  const code = esbuild.transformSync(`${source}\nreturn ${name};`, { loader: 'tsx', jsx: 'transform' }).code;
  return Function('React', ...Object.keys(env), code)(React, ...Object.values(env));
};
const PercentGauge = compile('widgets/PercentGauge.tsx', 'PercentGauge');
const gauge = value => renderToStaticMarkup(React.createElement(PercentGauge, { value, label: 'CPU' }));
for (const missing of [null, NaN, Infinity]) {
  const html = gauge(missing);
  assert.match(html, /aria-label="CPU: —"/);
  assert.match(html, /visibility="hidden"/);
  assert.doesNotMatch(html, /text-success|>0%</);
}
assert.match(gauge(0), /aria-label="CPU: 0%"/);
assert.match(gauge(0), /text-success/);
assert.match(gauge(150), /aria-label="CPU: 100%"/);
assert.match(gauge(-5), /aria-label="CPU: 0%"/);

class ApiError extends Error {
  constructor(status) { super('fixture'); this.status = status; }
}
const data = {
  monitor: { active: 1, name: 'Private fixture name' },
  online: true, staleAfterSec: 180, now: Math.floor(Date.now() / 1000),
  live: { reported_at: Math.floor(Date.now() / 1000), cpu_usage: null }, buckets: [],
};
let state = { data, isLoading: false };
const empty = () => null;
const AgentDetailContent = compile('AgentDetailContent.tsx', 'AgentDetailContent', {
  ApiError, PercentGauge, clsx,
  useSWR: () => state,
  useTranslations: () => key => key,
  useEffect: () => {}, useMemo: fn => fn(), useState: fn => [fn(), () => {}],
  requestJson: empty, isRetryableApiError: empty,
  HistoryNotice: empty, TimeSeriesChart: empty, AvailabilityRail: empty,
  Card: 'section', CardBody: 'div', CardHeader: 'header',
  Chip: ({ children, className }) => React.createElement('span', { className }, children),
  ...Object.fromEntries(['Activity', 'AlertTriangle', 'Check', 'Clock', 'Cpu', 'HardDrive', 'Layers', 'MemoryStick', 'RefreshCw'].map(key => [key, empty])),
});
const render = () => renderToStaticMarkup(React.createElement(AgentDetailContent, { numId: 1 }));
assert.match(render(), />detail.up</);
assert.match(render(), /aria-label="detail.cpuUsage: —"/);
data.online = false;
assert.match(render(), />detail.down</);
assert.doesNotMatch(render(), />detail.up</);
const reportedAt = data.live.reported_at;
data.live.reported_at = null;
assert.match(render(), />detail.down</);
data.live.reported_at = reportedAt;
data.online = null;
assert.match(render(), />detail.unknown</);
data.online = true;
data.live.reported_at -= 200;
assert.match(render(), />detail.down</);
data.monitor.active = 0;
assert.match(render(), />timer.paused</);
assert.doesNotMatch(render(), />detail.down</);
state.error = new ApiError(503);
assert.match(render(), /Private fixture name/);
for (const status of [401, 403, 404]) {
  state.error = new ApiError(status);
  assert.doesNotMatch(render(), /Private fixture name/);
}
console.log('PASS public Agent gauges, disabled/fresh/stale states and revoked visibility');
