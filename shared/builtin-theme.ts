import { DEFAULT_PAGE_VIEW, type PageKind, type PageSettings, type PageView } from './presentation';

export interface BuiltinThemeOption {
  key: string;
  label: string;
  type: 'color' | 'number' | 'boolean' | 'select' | 'string';
  default: string | number | boolean;
  choices?: string[];
  description?: string;
  min?: number;
  max?: number;
  step?: number;
}
export type BuiltinPageView = PageSettings & PageView;

export function builtinThemeOptions(kind: PageKind): BuiltinThemeOption[] {
  const boolean = (key: string): BuiltinThemeOption => ({ key, label: key, type: 'boolean', default: true });
  return [
    ...(kind === 'ai' ? [{ key: 'title', label: 'title', type: 'string' as const, default: '' }, { key: 'description', label: 'description', type: 'string' as const, default: '' }] : []),
    { key: 'accent', label: 'accent', type: 'color', default: '#6366F1' },
    { key: 'radius', label: 'radius', type: 'number', min: 0, max: 32, step: 1, default: 12 },
    { key: 'width', label: 'width', type: 'number', min: 720, max: 1920, step: 1, default: 1440 },
    { key: 'density', label: 'density', type: 'select', choices: ['compact', 'normal', 'comfortable'], default: 'normal' },
    { key: 'layout', label: 'layout', type: 'select', choices: ['list', 'cards'], default: kind === 'agent' ? 'cards' : 'list' },
    { key: 'columns', label: 'columns', type: 'number', min: 1, max: 4, step: 1, default: 3 },
    boolean('showHistory'),
    ...(kind === 'agent' ? ['showCountry'] : kind === 'ai' ? ['showLatency', 'showAvailability'] : ['showLatency', 'showAvailability', 'showExpiry']).map(boolean),
  ];
}

export function validateBuiltinThemeOptions(kind: PageKind, values: unknown): values is Record<string, unknown> {
  if (!values || typeof values !== 'object' || Array.isArray(values)) return false;
  const options = new Map(builtinThemeOptions(kind).map(option => [option.key, option]));
  return Object.entries(values).every(([key, value]) => {
    const option = options.get(key);
    if (!option) return false;
    switch (option.type) {
      case 'string': return typeof value === 'string' && [...value].length <= (key === 'title' ? 200 : 1000);
      case 'boolean': return typeof value === 'boolean';
      case 'color': return typeof value === 'string' && value.length === 7 && /^#[a-f0-9]{6}$/i.test(value);
      case 'number': return typeof value === 'number' && Number.isInteger(value) && value >= option.min! && value <= option.max!;
      case 'select': return typeof value === 'string' && option.choices!.includes(value);
    }
  });
}

export function resolveBuiltinPageView(kind: PageKind, page: PageSettings): BuiltinPageView {
  const view: BuiltinPageView = { ...DEFAULT_PAGE_VIEW, layout: kind === 'agent' ? 'cards' : 'list', ...page };
  if (page.theme !== null) return view;
  if (!validateBuiltinThemeOptions(kind, page.themeOptions)) throw new Error('invalid_builtin_theme_options');
  const showCountry = view.showCountry;
  Object.assign(view, Object.fromEntries(builtinThemeOptions(kind).map(option => [option.key, page.themeOptions[option.key] ?? option.default])));
  view.showCountry = showCountry && view.showCountry;
  return view;
}
