import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { test } from 'node:test';

const require = createRequire(import.meta.url);
const { transformSync } = require('../../frontend/node_modules/esbuild');
const React = { createElement: (type, props, ...children) => ({ type, props: { ...props, children } }) };
class ApiError extends Error { constructor(status) { super('API error'); this.status = status; } }
function route(file, resource) {
  const source = transformSync(readFileSync(`frontend/src/routes/${file}.tsx`, 'utf8'), { loader: 'tsx', format: 'cjs', jsx: 'transform' }).code;
  const module = { exports: {} }, components = new Proxy({}, { get: (_, name) => name });
  const modules = {
    react: { lazy: () => 'Lazy', Suspense: 'Suspense', useEffect() {} },
    'react-router': { useParams: () => ({}) },
    '@/api/errors': { ApiError },
    '@/config/usePublicConfig': { usePublicConfig: () => resource },
    '@/config/api': { toPageConfig: data => data },
    'next-themes': { useTheme: () => ({ setTheme() {} }) },
    '@/i18n/IntlProvider': { useLocale: () => ({ applyDefaultLocale() {} }) },
  };
  Function('require', 'module', 'exports', 'React', source)(id => modules[id] ?? components, module, module.exports, React);
  return module.exports[file]();
}
test('disabled and unconfigured public presentations use the existing not-found surface', () => {
  for (const file of ['PublicPageRoute', 'StatusPageRoute']) {
    for (const presentation of [{ configured: true, enabled: false }, { configured: false, enabled: true }]) {
      const tree = route(file, { data: { presentation } });
      assert.equal(tree.type, 'RouteError'); assert.equal(tree.props.code, 'notFound');
    }
    assert.equal(route(file, { error: new ApiError(404) }).props.code, 'notFound');
    assert.equal(route(file, { error: new ApiError(503) }).props.code, 'render');
  }
});

test('theme definitions for disabled machine and AI pages are not rendered', () => {
  const source = readFileSync('frontend/src/admin/themes/ThemesPage.tsx', 'utf8');
  const start = source.indexOf('function VersionRow(');
  const code = transformSync(source.slice(start).split('\nfunction ')[0] + '\nmodule.exports=VersionRow;', { loader: 'tsx', jsx: 'transform' }).code;
  const module = { exports: {} };
  Function('module', 'React', 'useTranslations', code)(module, React, () => key => key);
  for (const target of ['agent', 'ai']) {
    const result = module.exports({ theme: { short: 'fixture' }, version: { versionKey: 'v1' }, definition: { id: 'one', target }, presentation: { config: { agentEnabled: false, aiEnabled: false, pages: { [target]: { theme: null } } } } });
    assert.equal(result, null);
  }
});
