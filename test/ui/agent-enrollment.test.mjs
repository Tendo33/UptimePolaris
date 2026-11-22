import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const esbuild = require('../../frontend/node_modules/esbuild');
const sources = new Map();
const React = { Fragment: 'Fragment', createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
const components = new Proxy({}, { get: (_, key) => key });
const settle = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const findAll = (node, predicate) => !node || typeof node !== 'object' ? [] : [
  ...(predicate(node) ? [node] : []), ...(node.props?.children ?? []).flat(Infinity).flatMap(child => findAll(child, predicate)),
];
// Function components in the tree are expanded so a wrapper like the agent
// management gate does not hide the page below it.
// 展开函数类型的节点，避免管理开关这类包装组件挡住下面的页面。
const expand = (node, depth = 0) => {
  if (!node || typeof node !== 'object' || depth > 20) return node;
  if (typeof node.type === 'function') {
    const rendered = node.type(node.props ?? {});
    return expand(rendered, depth + 1);
  }
  if (!node.props?.children) return node;
  return { ...node, props: { ...node.props, children: node.props.children.flat(Infinity).map(child => expand(child, depth)) } };
};
const text = node => typeof node === 'string' ? node : (node?.props?.children ?? []).flat(Infinity).map(text).join(' ');
const find = (tree, type, label) => findAll(tree, node => node.type === type && (!label || node.props.label === label || node.props['aria-label'] === label || text(node) === label))[0];
const modeSelect = tree => find(tree, 'Select', 'admin.agent.installMode');

function load(path, modules = {}, window = {}) {
  if (!sources.has(path)) sources.set(path, esbuild.transformSync(readFileSync(path, 'utf8'), { loader: path.endsWith('.tsx') ? 'tsx' : 'ts', format: 'cjs', jsx: 'transform' }).code);
  const module = { exports: {} };
  Function('require', 'module', 'exports', 'React', 'window', sources.get(path))(
    id => id in modules ? modules[id] : components, module, module.exports, React, window,
  );
  return module.exports;
}
const install = load('shared/agent-install.ts', {
  './agent-release-repository.json': JSON.parse(readFileSync('shared/agent-release-repository.json', 'utf8')),
});

function fixture(component = 'AddAgentPanel') {
  const slots = [], requests = [], creations = [], translations = new Map();
  let cursor = 0, pending = [], dirty = false, closes = 0;
  const changed = (previous, next) => !previous || !next || previous.length !== next.length || next.some((value, i) => !Object.is(value, previous[i]));
  const useState = initial => {
    const i = cursor++;
    if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
    return [slots[i], value => { const next = typeof value === 'function' ? value(slots[i]) : value; if (!Object.is(slots[i], next)) { slots[i] = next; dirty = true; } }];
  };
  const useMemo = (fn, deps) => { const i = cursor++; if (!slots[i] || changed(slots[i].deps, deps)) slots[i] = { deps, value: fn() }; return slots[i].value; };
  const useEffect = (fn, deps) => {
    const i = cursor++;
    if (!slots[i] || changed(slots[i].deps, deps)) { const cleanup = slots[i]?.cleanup; slots[i] = { deps }; pending.push(() => { cleanup?.(); slots[i].cleanup = fn(); }); }
  };
  const useRef = initial => { const i = cursor++; return slots[i] ??= { current: initial }; };
  const useTranslations = namespace => {
    if (!translations.has(namespace)) translations.set(namespace, key => `${namespace}.${key}`);
    return translations.get(namespace);
  };
  const taxonomy = { enabled: true, groups: [{ id: 'g1', name: 'Fleet', weight: 0, count: 0 }], tags: [{ id: 't1', name: 'Edge', color: '#123456', count: 0 }], error: null, load: async () => {} };
  const window = { location: { origin: 'http://preview.test' }, setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {} };
  const errorMessage = error => `api:${error.message}`;
  const modules = {
    react: { useState, useEffect, useMemo, useRef, useCallback: (fn, deps) => useMemo(() => fn, deps) },
    'use-intl': { useTranslations },
    '@/api/useApiErrorMessage': { useApiErrorMessage: () => errorMessage },
    '@/api/client': { requestJson: (url, options) => {
      requests.push({ url, options });
      assert.equal(url, '/api/admin/agents', 'enrollment must not query release capabilities');
      return Promise.resolve({ agents: [] });
    } },
    '@/lib/useReducedMotion': { useReducedMotion: () => true },
    'framer-motion': { AnimatePresence: 'AnimatePresence', LayoutGroup: 'LayoutGroup', motion: { div: 'motion.div' } },
    clsx: (...values) => values.filter(Boolean).join(' '),
    '../../../../shared/agent-install': install,
    './Taxonomy': { useAgentTaxonomy: () => taxonomy, TaxonomyFields: 'TaxonomyFields' },
    '../useConsoleData': { useFleet: () => ({ data: { agents: [], summary: null }, error: null, mutate: async () => {} }) },
    './api': {
      agentsApi: { createAgent: async input => { creations.push(input); return { id: 'regression-agent', token: 'fixture-token' }; }, listAgents: async () => ({ agents: [], summary: null }) },
      taxonomyApi: { assign: async () => {} },
    },
    // Agent management sits behind the machine-page setting, so these tests
    // stub the gate open and cover the enabled page.
    // Agent 管理受机器页设置控制，这里让 gate 直接放行，验证已启用时的页面。
    './AgentManagementGate': { AgentManagementGate: ({ children }) => React.createElement('Gate', null, children) },
    './useAgentUpdateCheck': { useAgentUpdateCheck: () => ({ checking: false, check: async () => {} }) },
    '@/components/ui/toast': { toast: { success: () => {}, error: () => {} } },
    '../settings/presentation-api': { usePresentation: () => ({ data: { config: { agentEnabled: true } } }), updatePresentation: async () => {} },
    'react-router': { useNavigate: () => () => {}, useSearchParams: () => [new URLSearchParams(), () => {}] },
  };
  const Component = load(`frontend/src/admin/agents/${component === 'TaxonomyFields' ? 'Taxonomy' : component}.tsx`, modules, window)[component];
  const props = { open: true, onClose: () => { props.open = false; closes++; }, onCreated: async () => {} };
  if (component === 'TaxonomyFields') Object.assign(props, {
    groups: taxonomy.groups, tags: taxonomy.tags, groupId: null, tagIds: [],
    onGroupChange: id => { props.groupId = id; }, onTagsChange: ids => { props.tagIds = ids; },
    onCreateGroup: async name => { const id = 'new-group'; props.groups = [...props.groups, { id, name }]; return id; },
    onCreateTag: async name => { const id = 'new-tag'; props.tags = [...props.tags, { id, name }]; return id; },
  });
  const render = () => {
    for (let pass = 0; pass < 15; pass++) {
      cursor = 0; pending = []; dirty = false;
      const tree = expand(Component(props));
      pending.forEach(effect => effect());
      if (!dirty) return tree;
    }
    throw Error('fixture render did not settle');
  };
  const dispose = () => slots.forEach(slot => slot?.cleanup?.());
  return { render, props, requests, creations, taxonomy, dispose, get closes() { return closes; } };
}

function nameAgent(f) {
  find(f.render(), 'Input', 'admin.agents.addName').props.onValueChange('Stagewise Agent UI regression');
  return f.render();
}

function continueCreation(tree) {
  const button = find(tree, 'Button', 'admin.agents.continue');
  assert.equal(button.props.isDisabled, false);
  button.props.onPress();
}

function assertModes(tree) {
  const select = modeSelect(tree);
  assert.deepEqual(select.props.items.map(item => item.key), ['system', 'user', 'manual', 'docker']);
  assert.deepEqual(select.props.selectedKeys, ['system']);
  assert.deepEqual(select.props.items.map(item => select.props.children[0](item).props.textValue), [
    'admin.agent.mode_system', 'admin.agent.mode_user', 'admin.agent.mode_manual', 'admin.agent.mode_docker',
  ]);
}

test('Agent list retains taxonomy filters and add flow without quick management or its dialogs', async () => {
  const f = fixture('AgentsPage');
  try {
    f.render(); await settle(); let tree = f.render();
    assert.equal(find(tree, 'Button', 'admin.agentTaxonomy.manageTags'), undefined);
    assert.equal(find(tree, 'Button', 'admin.agentTaxonomy.addGroup'), undefined);
    const group = find(tree, 'Select', 'admin.agentTaxonomy.group');
    const tags = find(tree, 'Select', 'admin.agentTaxonomy.tags');
    group.props.onSelectionChange(new Set(['g1'])); tags.props.onSelectionChange(new Set(['t1']));
    tree = f.render();
    assert.deepEqual(find(tree, 'Select', 'admin.agentTaxonomy.group').props.selectedKeys, ['g1']);
    assert.deepEqual(find(tree, 'Select', 'admin.agentTaxonomy.tags').props.selectedKeys, ['t1']);
    assert.equal(findAll(tree, node => ['TaxonomyEditor', 'TaxonomyDelete'].includes(node.type)).length, 0);
    find(tree, 'Button', 'admin.agents.enroll').props.onPress();
    assert.equal(find(f.render(), 'AddAgentPanel').props.open, true);
    const page = readFileSync('frontend/src/admin/agents/AgentsPage.tsx', 'utf8');
    assert.doesNotMatch(page, /TaxonomyEditor|TaxonomyDelete|tagsOpen|groupEditorOpen|tagEditor|tagDelete/);
  } finally { f.dispose(); }
});

test('Taxonomy supports inline creation, selection and removable tags', async () => {
  const f = fixture('TaxonomyFields');
  try {
    let tree = f.render();
    assert.equal(tree.props.className, 'grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2');
    const group = () => find(f.render(), 'Autocomplete', 'admin.agentTaxonomy.group');
    const tags = () => find(f.render(), 'Autocomplete', 'admin.agentTaxonomy.tags');
    group().props.onSelectionChange('g1'); assert.equal(f.props.groupId, 'g1');
    group().props.onSelectionChange('__ungrouped'); assert.equal(f.props.groupId, null);
    group().props.onInputChange('New fleet');
    assert.ok(findAll(f.render(), node => node.type === 'AutocompleteItem' && node.props.key === '__create_group').length);
    group().props.onSelectionChange('__create_group'); await settle();
    assert.equal(f.props.groupId, 'new-group');
    assert.equal(group().props.inputValue, 'New fleet');
    tags().props.onSelectionChange('t1'); assert.deepEqual(f.props.tagIds, ['t1']);
    tags().props.onInputChange('New tag'); tags().props.onSelectionChange('__create_tag'); await settle();
    assert.deepEqual(f.props.tagIds, ['t1', 'new-tag']);
    assert.equal(tags().props.inputValue, '');
    tree = f.render();
    findAll(tree, node => node.type === 'Chip' && node.props.key === 't1')[0].props.onClose();
    assert.deepEqual(f.props.tagIds, ['new-tag']);
    f.props.disabled = true;
    assert.ok(findAll(f.render(), node => node.type === 'Autocomplete').every(node => node.props.isDisabled));
  } finally { f.dispose(); }
});

test('Failed taxonomy creation retains input and can be retried without duplicates', async () => {
  const f = fixture('TaxonomyFields');
  try {
    const pending = deferred(); let calls = 0;
    f.props.onCreateGroup = () => { calls++; return pending.promise; };
    find(f.render(), 'Autocomplete', 'admin.agentTaxonomy.group').props.onInputChange('Retry fleet');
    const group = find(f.render(), 'Autocomplete', 'admin.agentTaxonomy.group');
    group.props.onSelectionChange('__create_group'); group.props.onSelectionChange('__create_group');
    assert.equal(calls, 1);
    pending.reject(Error('name_taken')); await settle();
    const tree = f.render();
    assert.equal(find(tree, 'Autocomplete', 'admin.agentTaxonomy.group').props.inputValue, 'Retry fleet');
    assert.ok(find(tree, 'p', 'api:name_taken'));
    assert.equal(f.props.groupId, null);
    f.props.onCreateGroup = async () => 'retried';
    find(f.render(), 'Autocomplete', 'admin.agentTaxonomy.group').props.onSelectionChange('__create_group'); await settle();
    assert.equal(f.props.groupId, 'retried');
  } finally { f.dispose(); }
});

test('Agent installation uses defaults immediately and detects the host in its scripts', async () => {
  const f = fixture();
  try {
    let tree = nameAgent(f); assertModes(tree);
    assert.equal(f.requests.length, 0);
    continueCreation(tree); await settle(); tree = f.render();
    const commands = findAll(tree, node => node.type === 'code').map(text);
    assert.equal(commands.length, 3);
    for (const command of commands) {
      assert.doesNotMatch(command, /--platform|-platform|x86_64|aarch64/);
      assert.match(command, /install\.(sh|ps1)/);
    }
    assert.ok(f.requests.every(request => request.url === '/api/admin/agents'));
    assert.deepEqual(f.creations, [{ name: 'Stagewise Agent UI regression', probe_enabled: true }]);
  } finally { f.dispose(); }
});

test('Docker selection produces a Linux-only command without querying releases', async () => {
  const f = fixture();
  try {
    let tree = nameAgent(f);
    modeSelect(tree).props.onChange({ target: { value: 'docker' } });
    continueCreation(f.render()); await settle(); tree = f.render();
    const commands = findAll(tree, node => node.type === 'code');
    assert.equal(commands.length, 1);
    assert.match(text(commands[0]), /--mode 'docker'/);
  } finally { f.dispose(); }
});
