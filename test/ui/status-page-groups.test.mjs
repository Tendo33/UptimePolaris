// Render the real StatusPage with isolated data and UI dependencies.
// 隔离数据与界面依赖，渲染实际 StatusPage。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { transformSync } from 'esbuild';

const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
function load(path, modules = {}) {
  const code = transformSync(readFileSync(path, 'utf8'), { loader: path.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', jsx: 'transform' }).code;
  const module = { exports: {} };
  Function('require', 'module', 'exports', 'React', 'window', code)(id => {
    assert.ok(id in modules, `unexpected dependency: ${id}`);
    return modules[id];
  }, module, module.exports, React, { localStorage: { getItem: () => null } });
  return module.exports;
}
const status = load('frontend/src/lib/monitor-status.ts');
const filters = load('frontend/src/components/status-page/monitor-filters.ts', { '@/lib/monitor-status': status });
const findAll = (node, type) => !node || typeof node !== 'object' ? [] : [
  ...(node.type === type ? [node] : []), ...(node.props?.children ?? []).flat(Infinity).flatMap(child => findAll(child, type)),
];
const text = node => typeof node === 'string' ? node : (node?.props?.children ?? []).flat(Infinity).map(text).join(' ');
const monitor = { id: 1, name: 'API', url: 'https://example.com', tags: [] };
const named = { id: 1, name: 'Production', monitorList: [monitor] };
const empty = { id: 2, name: 'Empty', monitorList: [] };
const ungrouped = { id: 0, name: null, isUngrouped: true, monitorList: [] };

function render(monitorGroups, { isFiltering = false, searchTerm = '', filterStatus = 'all', searchInGroup = false, isError = false } = {}) {
  const subscriptions = { items: [], isLoading: false, hidden: true };
  const { StatusPage } = load('frontend/src/components/status-page/StatusPage.tsx', {
    react: { useMemo: fn => fn(), useCallback: fn => fn, useState: value => [typeof value === 'function' ? value() : value, () => {}] },
    'use-intl': { useTranslations: () => key => key },
    'framer-motion': { AnimatePresence: 'AnimatePresence', motion: { div: 'motion.div' } },
    'lucide-react': { CloudOff: 'CloudOff', SearchX: 'SearchX' },
    '@/components/context/PageConfigContext': { usePageConfig: () => ({}) },
    '@/components/context/PresentationViewContext': { usePresentationView: () => null },
    '@/components/status-page/GroupSection': { GroupSection: 'GroupSection', GroupSkeleton: 'GroupSkeleton' },
    '@/components/status-page/monitor-filters': filters,
    '@/components/status-page/MonitorFilterContext': { useMonitorFilters: () => ({ isFiltering, searchTerm, filterStatus, searchInGroup }) },
    '@/components/status-page/StatusHero': { StatusHero: 'StatusHero' },
    '@/components/status-page/Toolbar': { Toolbar: 'Toolbar' },
    '@/components/status-page/useRefreshTimer': { useRefreshTimer: () => ({}) },
    '@/components/status-page/useStatusPageData': {
      useConfig: () => ({}), usePublicAiModels: () => ({}),
      useMonitorData: () => ({ monitorGroups, monitoringData: { heartbeatList: { 1: [{ status: 1 }] }, uptimeList: {} }, isLoading: false, isError, receivedAt: null }),
    },
    './AiModels': { filterAiModels: () => [] },
    '@/components/ai/status': {},
    '@/api/errors': { ApiError: class extends Error {} },
    '../subscriptions/PublicSubscriptions': { usePublicSubscriptions: () => subscriptions, filterSubscriptions: () => [] },
    '@/lib/monitor-status': status,
    '@/lib/motion': {},
  });
  return StatusPage({});
}

test('unfiltered status page omits empty named and ungrouped sections', () => {
  const populated = { ...ungrouped, monitorList: [{ ...monitor, id: 2, name: 'Other' }] };
  for (const bucket of [ungrouped, populated]) {
    const tree = render([empty, named, bucket]);
    const expected = bucket.monitorList.length ? [named, bucket] : [named];
    assert.deepEqual(findAll(tree, 'GroupSection').map(node => node.props.group), expected);
    assert.equal(findAll(tree, 'Toolbar')[0].props.matched, expected.length);
  }
});

test('zero groups and all-empty groups show the normal empty state', () => {
  for (const groups of [[], [empty, ungrouped]]) {
    const tree = render(groups);
    assert.equal(findAll(tree, 'GroupSection').length, 0);
    assert.match(text(tree), /common.list.empty/);
    assert.doesNotMatch(text(tree), /node.noMatchingResults|error.requestData/);
  }
});

test('search and status filters still drop empty groups and keep matching monitors', () => {
  for (const options of [
    { searchTerm: 'api' }, { searchTerm: 'production', searchInGroup: true }, { filterStatus: 'up' },
  ]) {
    const tree = render([empty, named, ungrouped], { ...options, isFiltering: true });
    assert.deepEqual(findAll(tree, 'GroupSection').map(node => node.props.group.id), [1]);
  }
  const tree = render([empty, named, ungrouped], { isFiltering: true, filterStatus: 'down' });
  assert.equal(findAll(tree, 'GroupSection').length, 0);
  assert.match(text(tree), /node.noMatchingResults/);
});

test('request errors use monitor presence before filtering', () => {
  for (const groups of [[], [empty, ungrouped]]) {
    assert.match(text(render(groups, { isError: true })), /error.requestData/);
  }
  const tree = render([named, ungrouped], { isError: true, isFiltering: true, searchTerm: 'missing' });
  assert.match(text(tree), /node.noMatchingResults/);
  assert.doesNotMatch(text(tree), /error.requestData/);
});

test('theme SDK passes through empty, grouped-only and mixed monitor groups', async () => {
  const window = { location: { pathname: '/' } };
  const document = { currentScript: { dataset: { capabilities: 'public.monitors' } } };
  for (const monitorGroups of [[], [named], [named, { ...ungrouped, monitorList: [monitor] }]]) {
    const payload = { success: true, monitorGroups };
    const fetch = async path => {
      assert.equal(path, '/api/public/monitors');
      return { ok: true, json: async () => payload };
    };
    Function('window', 'document', 'fetch', readFileSync('frontend/public/polaris-theme-sdk.js', 'utf8'))(window, document, fetch);
    assert.equal(await window.polarisTheme.read('monitors'), payload);
  }
});
