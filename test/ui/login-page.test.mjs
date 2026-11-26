// Render LoginPage with a stub session to check external/local separation.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const esbuild = require('../../frontend/node_modules/esbuild');

const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
const source = readFileSync('frontend/src/auth/LoginPage.tsx', 'utf8')
  .replace(/^import[\s\S]*?;\r?\n/gm, '')
  .replace('export function LoginPage', 'function LoginPage')
  .replace('const BRAND_ICON = buildIconProxyUrl(undefined, { tight: true });', '');
const code = esbuild.transformSync(`const BRAND_ICON = 'icon';\n${source}\nreturn LoginPage;`, { loader: 'tsx', jsx: 'transform' }).code;

class ApiError extends Error {
  constructor(status) {
    super('error');
    this.status = status;
  }
}

let session;
let externalError;
const state = [];
let cursor = 0;
const noop = () => {};
const useState = initial => {
  const index = cursor++;
  if (!(index in state)) state[index] = typeof initial === 'function' ? initial() : initial;
  return [state[index], value => { state[index] = typeof value === 'function' ? value(state[index]) : value; }];
};

const LoginPage = Function(
  'React', 'useState', 'useEffect', 'useRef', 'useAuth', 'useTranslations', 'useNavigate', 'useLocation',
  'Navigate', 'AuthSplash', 'AuthProductPanel', 'PasswordInput', 'ThemeSwitch', 'LocaleSwitch', 'Button', 'Input',
  'motion', 'ApiError', 'PROJECT_NAME', 'CONTENT_TRANSITION',
  'AlertCircle', 'ArrowRight', 'ArrowUpRight', 'Loader2', 'Lock', 'ShieldCheck', 'UserRound',
  code,
)(React, useState, noop, () => ({ current: null }),
  () => ({
    session,
    login: async () => {},
    externalLogin: async () => { throw externalError; },
  }),
  () => key => key, () => noop, () => ({ state: null }), 'Navigate', 'AuthSplash', 'AuthProductPanel',
  'PasswordInput', 'ThemeSwitch', 'LocaleSwitch', 'Button', 'Input', { div: 'motion.div' }, ApiError, 'Polaris', {},
  'AlertCircle', 'ArrowRight', 'ArrowUpRight', 'Loader2', 'Lock', 'ShieldCheck', 'UserRound');

const walk = (node, out = []) => {
  if (!node || typeof node !== 'object') return out;
  out.push(node);
  (node.props?.children ?? []).flat(Infinity).forEach(child => walk(child, out));
  return out;
};
const text = node => (node.props?.children ?? []).flat(Infinity).filter(value => typeof value === 'string').join('');

function render(mode) {
  session = { authenticated: false, needsSetup: false, externalAuth: mode ? { mode } : null };
  cursor = 0;
  return walk(LoginPage());
}

{
  const nodes = render('cloudflare-access');
  const form = nodes.find(node => node.type === 'form');
  const buttons = nodes.filter(node => node.type === 'Button' || node.type === 'button');
  const external = buttons.find(button => text(button).includes('login.externalSubmitCloudflare'));
  assert.ok(external, 'Cloudflare mode renders its own label');
  assert.equal(external.props.color, 'primary');
  assert.equal(external.props.className.includes('h-10 w-full text-[13.5px] font-medium'), true);
  assert.equal(walk(form).includes(external), false, 'external button sits outside the local form');
  const externalBlock = nodes.find(node => node.type === 'div' && node.props?.className === 'mb-4' && walk(node).includes(external));
  assert.ok(externalBlock, 'external auth is its own div block');
  const divider = nodes.find(node =>
    node.props?.className?.includes('mb-4 flex items-center gap-3') &&
    walk(node).some(child => text(child).includes('login.orLocalAccount')),
  );
  assert.ok(divider, 'divider copy is present');
  assert.ok(nodes.indexOf(externalBlock) < nodes.indexOf(divider), 'divider follows the external block');
  assert.ok(nodes.indexOf(divider) < nodes.indexOf(form), 'divider sits before the local form');
  assert.ok(nodes.some(node => node.props?.className?.includes('h-px flex-1 bg-[var(--polaris-line)]')), 'divider rule is present');
  assert.ok(nodes.some(node => text(node).includes('login.externalLogoutHint')), 'logout hint is present');
  const username = walk(form).find(node => node.type === 'Input');
  assert.equal(username.props.autoFocus, false, 'external mode does not steal focus');
  const submit = nodes.find(node => node.type === 'Button' && node.props.type === 'submit');
  assert.equal(submit.props.color, 'default', 'local submit is demoted when external auth is primary');
  assert.equal(submit.props.variant, 'bordered');
  assert.equal(submit.props.className.includes('h-10 w-full'), true);
}

{
  const nodes = render('trusted-header');
  const external = nodes.find(node => text(node).includes('login.externalSubmitProxy'));
  assert.ok(external, 'trusted-header mode renders its own label');
  assert.equal(nodes.some(node => text(node).includes('login.externalSubmitCloudflare')), false);
}

{
  const nodes = render('trusted-header');
  const external = nodes.find(node => text(node).includes('login.externalSubmitProxy'));
  assert.equal(external.props.isDisabled, false);
}

{
  const nodes = render(null);
  assert.equal(nodes.some(node => node.props?.role === 'alert'), false);
  assert.equal(nodes.some(node => text(node).includes('login.externalSubmitProxy')), false);
  const username = nodes.find(node => node.type === 'Input');
  assert.equal(username.props.autoFocus, true, 'local-only mode keeps autofocus');
  const submit = nodes.find(node => node.type === 'Button' && node.props.type === 'submit');
  assert.equal(submit.props.color, 'primary');
}

{
  externalError = new ApiError(503);
  const nodes = render('cloudflare-access');
  const external = nodes.find(node => text(node).includes('login.externalSubmitCloudflare'));
  await external.props.onPress();
  const rendered = render('cloudflare-access');
  const alerts = rendered.filter(node => node.props?.role === 'alert');
  assert.equal(alerts.length, 1, 'external failures render in the external block only');
  assert.ok(text(alerts[0]).includes('login.dbUnavailable'));
  const externalBlock = rendered.find(node => node.type === 'div' && node.props?.className === 'mb-4');
  assert.ok(externalBlock && walk(externalBlock).includes(alerts[0]), 'external failure sits in the external block');
  const form = rendered.find(node => node.type === 'form');
  assert.equal(walk(form).some(node => node.props?.role === 'alert'), false, 'local form stays clean');
}

{
  externalError = new Error('network_error');
  const nodes = render('trusted-header');
  const external = nodes.find(node => text(node).includes('login.externalSubmitProxy'));
  await external.props.onPress();
  const alerts = render('trusted-header').filter(node => node.props?.role === 'alert');
  assert.ok(text(alerts[0]).includes('login.network'));
}

console.log('PASS login page external block, mode labels, errors and local fallback');
