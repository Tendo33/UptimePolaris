import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { transformSync } = require('../../frontend/node_modules/esbuild');
const React = { Fragment: 'Fragment', createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
const components = new Proxy({}, { get: (_, key) => key });
const all = (tree, predicate) => Array.isArray(tree) ? tree.flatMap(child => all(child, predicate)) : !tree || typeof tree !== 'object' ? [] : [...(predicate(tree) ? [tree] : []), ...all(tree.props.children, predicate)];

function load(file, modules = {}) {
  const code = transformSync(readFileSync(`frontend/src/admin/subscriptions/${file}`, 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code;
  const module = { exports: {} };
  const defaults = {
    react: { useRef: value => ({ current: value }), useState: value => [typeof value === 'function' ? value() : value, () => {}], useEffect() {} },
    'react-router': { Link: 'Link', useNavigate: () => () => {}, useSearchParams: () => [new URLSearchParams(), () => {}] },
    'use-intl': { useTranslations: () => Object.assign(key => key, { has: () => true }), useFormatter: () => ({ relativeTime: () => 'soon', dateTime: () => 'date', number: String }) },
    '@/hooks/useTimeAgo': { useTimeAgo: () => () => 'recently' },
    '@/components/subscriptions/observation': { stateTone: () => 'up', toneCounts: () => ({ up: 1 }) },
    clsx: (...values) => values.filter(Boolean).join(' '),
  };
  Function('require', 'module', 'exports', 'React', code)(id => modules[id] ?? defaults[id] ?? components, module, module.exports, React);
  return module.exports;
}

test('all subscription tabs remain on the detail pathname', () => {
  const { DetailTabs } = load('Parts.tsx');
  for (const active of ['items', 'runs', 'config', 'settings']) {
    const links = all(DetailTabs({ id: 'source/one', active }), node => node.type === 'Link');
    assert.equal(links.length, 4);
    for (const link of links) {
      const url = new URL(link.props.to, 'https://example.test');
      assert.equal(url.pathname, '/admin/subscriptions/source%2Fone');
      assert.equal(url.searchParams.get('tab'), link.props.key);
      assert.equal(link.props['aria-current'], link.props.key === active ? 'page' : undefined);
    }
  }
});

test('configuration shares the detail shell and refreshes the subscription after saving', async () => {
  let refreshed = 0;
  const keys = [];
  const subscription = { id: 'one', name: 'Fixture', category: 'website', enabled: true, archivedAt: null, templateName: 'JSON', templateVersion: '1.0.0', intervalSec: 300, runtime: { selectedCount: 1, itemCount: 1, nextDueAt: 0, health: 'healthy', lastSuccessAt: null } };
  const { SubscriptionDetail } = load('SubscriptionDetail.tsx', {
    './api': { useSubscription: () => ({ data: { subscription }, mutate: async () => { refreshed++; } }), subscriptionsApi: {} },
    './Parts': { ...components, DetailTabs: 'DetailTabs', Failure: 'Failure', Loading: 'Loading', useSubscriptionError: () => String, useDuration: () => () => '5 min', subscriptionHealth: () => 'healthy' },
    'react-router': { useNavigate: () => () => {}, useSearchParams: () => [new URLSearchParams('tab=config'), () => {}] },
    swr: key => { if (key) keys.push(key); return { mutate: async () => {} }; },
  });
  const tree = SubscriptionDetail({ id: 'one' });
  assert.equal(all(tree, node => node.type === 'AdminPage').length, 1);
  assert.equal(all(tree, node => node.type === 'DetailTabs')[0].props.active, 'config');
  const editor = all(tree, node => node.type === 'SubscriptionConfigEditor')[0];
  assert.equal(editor.props.id, 'one');
  assert.deepEqual(keys, []);
  await editor.props.onSaved();
  assert.equal(refreshed, 1);
});

test('embedded configuration refreshes its revision and parent without a second page shell', async () => {
  let configRefreshes = 0, parentRefreshes = 0;
  const resource = { data: { revision: 'r1', config: { descriptor: {}, parameters: {} } }, mutate: async () => { configRefreshes++; } };
  const { SubscriptionConfigEditor } = load('SubscriptionConfigEditor.tsx', { swr: () => resource });
  const tree = SubscriptionConfigEditor({ id: 'one', onSaved: async () => { parentRefreshes++; } });
  assert.equal(all(tree, node => node.type === 'AdminPage' || node.type === 'DetailTabs').length, 0);
  const editor = all(tree, node => typeof node.type === 'function' && node.type.name === 'Editor')[0];
  assert.equal(editor.props.revision, 'r1');
  await editor.props.onSaved();
  assert.deepEqual([configRefreshes, parentRefreshes], [1, 1]);
  resource.data = undefined;
  resource.error = new Error('Offline');
  const failed = SubscriptionConfigEditor({ id: 'one', onSaved: async () => {} });
  assert.equal(all(failed, node => typeof node.type === 'function' && node.type.name === 'Editor').length, 0);
  await all(failed, node => node.type === 'Failure')[0].props.retry();
  assert.equal(configRefreshes, 2);
});

test('model category disappears when AI is disabled and an active model filter is cleared', () => {
  for (const enabled of [false, true]) {
    const changes = [], effects = [];
    const { CategorySwitch } = load('Parts.tsx', {
      '../settings/presentation-api': { usePresentation: () => ({ data: { config: { aiEnabled: enabled } } }) },
      react: { useEffect: fn => effects.push(fn) },
    });
    const tree = CategorySwitch({ value: 'model', all: true, onChange: value => changes.push(value) });
    assert.equal(tree.props.options.some(option => option.value === 'model'), enabled);
    for (const effect of effects) effect();
    assert.deepEqual(changes, enabled ? [] : ['all']);
  }
});

test('center-aligned update notes center their icon and content without a top offset', () => {
  const { Note } = load('Parts.tsx');
  const tree = Note({ align: 'center', children: 'Update available' });
  assert.match(tree.props.className, /items-center/);
  const icon = tree.props.children[0];
  assert.doesNotMatch(icon.props.className, /mt-px/);
});

test('subscription list and library preserve one route transition boundary', () => {
  const source = transformSync(readFileSync('frontend/src/admin/layout/AdminLayout.tsx', 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code;
  let pathname = '/admin/subscriptions';
  const module = { exports: {} };
  const modules = {
    react: { Suspense: 'Suspense', useContext: () => ({}) },
    'react-router': { useLocation: () => ({ pathname }), useOutlet: () => 'outlet', UNSAFE_LocationContext: { Provider: 'Provider' } },
  };
  Function('require', 'module', 'exports', 'React', source)(id => modules[id] ?? components, module, module.exports, React);
  const key = () => all(module.exports.AdminLayout(), node => node.type === 'RouteTransition')[0].props.routeKey;
  const list = key();
  pathname = '/admin/subscriptions/library';
  assert.equal(key(), list);
  pathname = '/admin/subscriptions/example';
  assert.notEqual(key(), list);
});
