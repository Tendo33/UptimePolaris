import { Modal, Select } from '@/components/ui/MotionOverlays';
import { Segmented } from '@/components/ui/Segmented';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Button,
  Input,
  ModalContent,
  SelectItem,
  Slider,
  Switch,
  Textarea,
  Tooltip,
} from '@heroui/react';
import clsx from 'clsx';
import { AlertTriangle, ExternalLink, Bot, Monitor, RotateCcw, Server } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { ApiError } from '@/api/errors';
import { PREVIEW_DRAFT_MESSAGE, PREVIEW_READY_MESSAGE, type PreviewDraft } from '@/config/preview-draft';
import { resolveBuiltinPageView, validateBuiltinThemeOptions } from '../../../../shared/builtin-theme';
import { HEAD_CODE_MAX_BYTES, CONTENT_HTML_MAX_BYTES, utf8Length } from '../../../../shared/presentation';
import type { PageKind, PageSettings, PageTheme } from '../../../../shared/presentation';
import { updatePresentation } from '../settings/presentation-api';
import { useFleet, useOverview } from '../useConsoleData';
import { IconTile } from '../components/IconTile';
import { themesApi } from './api';
import { ThemeColorOption } from './ThemeColorOption';
import { ThemeSandbox } from './ThemePreviewFrame';
import type { ThemeDefinition, ThemeOption, ThemePreview } from './types';

type Viewport = 'desktop' | 'tablet' | 'mobile';
const VIEWPORT_WIDTH: Record<Viewport, number | null> = { desktop: null, tablet: 820, mobile: 390 };
const BUILTIN_GROUPS: Array<{ key: 'appearance' | 'layout' | 'display'; match: (key: string) => boolean }> = [
  { key: 'appearance', match: (key) => ['title', 'description', 'accent', 'radius', 'width'].includes(key) },
  { key: 'layout', match: (key) => ['layout', 'density', 'columns'].includes(key) },
  { key: 'display', match: (key) => key.startsWith('show') },
];

function sameTheme(a: PageTheme | null, b: PageTheme | null) {
  return a?.short === b?.short && a?.version === b?.version && a?.theme === b?.theme;
}

// 左侧编辑、右侧实时预览；未保存的更改只作用于预览，保存后才对访客生效。
// Edit on the left with a live preview on the right; unsaved changes only reach the preview.
export function ThemeEditor({ kind, page, definition, onClose }: {
  kind: PageKind;
  page: PageSettings;
  definition: ThemeDefinition;
  onClose: () => void;
}) {
  const t = useTranslations('admin.themes');
  const message = useApiErrorMessage();
  const [values, setValues] = useState(page.themeOptions);
  const [headCode, setHeadCode] = useState(page.headCode ?? '');
  const [contentHtml, setContentHtml] = useState(page.contentHtml ?? '');
  const [saved, setSaved] = useState({ values: page.themeOptions, headCode: page.headCode ?? '', contentHtml: page.contentHtml ?? '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState(false);
  const [viewport, setViewport] = useState<Viewport>('desktop');
  const builtin = page.theme === null;
  const dirty = JSON.stringify(values) !== JSON.stringify(saved.values) || headCode !== saved.headCode || contentHtml !== saved.contentHtml;
  const contentValid = utf8Length(headCode) <= HEAD_CODE_MAX_BYTES && utf8Length(contentHtml) <= CONTENT_HTML_MAX_BYTES;
  const optionsValid = builtin ? validateBuiltinThemeOptions(kind, values) : definition.options.every((option) => {
    const value = values[option.key];
    if (value === undefined) return true;
    if (option.type === 'color') return typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value);
    return option.type !== 'number' || (typeof value === 'number' && Number.isFinite(value) && (option.min === undefined || value >= option.min) && (option.max === undefined || value <= option.max));
  });

  function change(key: string, value: unknown) {
    setValues((current) => {
      const next = { ...current, [key]: value };
      if (value === undefined) delete next[key];
      return next;
    });
    setSuccess(false);
  }

  async function save() {
    if (saving || !dirty || !contentValid || !optionsValid) return;
    setSaving(true);
    setError(null);
    try {
      const result = await updatePresentation((config) => {
        if (!sameTheme(config.pages[kind].theme, page.theme)) throw new ApiError('presentation_conflict', 409);
        return { ...config, pages: { ...config.pages, [kind]: { ...config.pages[kind], themeOptions: values, headCode, contentHtml } } };
      });
      const next = result.config.pages[kind];
      setSaved({ values: next.themeOptions, headCode: next.headCode ?? '', contentHtml: next.contentHtml ?? '' });
      setSuccess(true);
    } catch (reason) {
      setError(reason);
    } finally {
      setSaving(false);
    }
  }

  // 预览只接收合法草稿，输入到一半的非法值保留上一次的有效画面。
  // Only valid drafts reach the preview; a half-typed value keeps the last good frame.
  const lastValid = useRef<{ values: Record<string, unknown>; headCode: string; contentHtml: string } | null>(null);
  if (optionsValid && contentValid) lastValid.current = { values, headCode, contentHtml };
  const draft = lastValid.current ?? { values: saved.values, headCode: saved.headCode, contentHtml: saved.contentHtml };

  const PageIcon = kind === 'monitor' ? Monitor : kind === 'ai' ? Bot : Server;
  const width = VIEWPORT_WIDTH[viewport];
  const groups = builtin
    ? BUILTIN_GROUPS.map((group) => ({ key: group.key, options: definition.options.filter((option) => group.match(option.key)) }))
    : [{ key: 'options' as const, options: definition.options }];
  const layout = values.layout ?? definition.options.find((option) => option.key === 'layout')?.default;

  return (
    <Modal isOpen size="full" hideCloseButton onClose={onClose} isDismissable={false} isKeyboardDismissDisabled={dirty || saving} classNames={{ base: 'm-0 rounded-none bg-[var(--polaris-canvas)]' }}>
      <ModalContent>
        <div className="flex h-dvh min-h-0 flex-col">
          <header className="flex flex-wrap items-center gap-3 border-b border-[var(--polaris-line)] bg-[var(--polaris-card)] px-4 py-2.5 sm:px-5">
            <IconTile icon={<PageIcon />} size="sm" />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[15px] font-semibold text-[var(--polaris-ink)]">{t('configure')}</h2>
              <p className="truncate text-[12px] text-[var(--polaris-ink-3)]">{t(kind === 'monitor' ? 'monitorBoard' : kind === 'ai' ? 'aiBoard' : 'serverBoard')} · {definition.name}</p>
            </div>
            <Segmented
              className="order-last w-full justify-center sm:order-none sm:w-auto"
              label={t('viewportLabel')}
              value={viewport}
              onChange={setViewport}
              options={[
                { value: 'desktop', label: t('viewport.desktop') },
                { value: 'tablet', label: t('viewport.tablet') },
                { value: 'mobile', label: t('viewport.mobile') },
              ]}
            />
            <div className="flex items-center gap-2">
              <span role="status" className={clsx('hidden items-center gap-1.5 text-[12px] md:inline-flex', dirty ? 'text-warning-700' : 'text-[var(--polaris-ink-3)]')}>
                <span className={clsx('h-1.5 w-1.5 rounded-full', dirty ? 'bg-warning' : success ? 'bg-success' : 'bg-transparent')} />
                {dirty ? t('settingsUnsaved') : success ? t('settingsSaved') : null}
              </span>
              <Button size="sm" variant="light" isDisabled={saving} onPress={onClose}>{dirty ? t('discardSettings') : t('closeSettings')}</Button>
              <Button size="sm" color="primary" isLoading={saving} isDisabled={!dirty || !contentValid || !optionsValid} onPress={() => void save()}>{t('saveSettings')}</Button>
            </div>
          </header>
          <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
            <aside className="max-h-[48dvh] shrink-0 overflow-y-auto border-b border-[var(--polaris-line)] bg-[var(--polaris-canvas)] lg:max-h-none lg:w-[400px] lg:border-b-0 lg:border-r" style={{ scrollbarGutter: 'stable' }}>
              <fieldset disabled={saving} className="flex flex-col gap-6 px-5 py-5">
                <p className="text-[12px] leading-5 text-[var(--polaris-ink-3)]">{t('settingsScope')}</p>
                {error ? <p role="alert" className="rounded-lg bg-danger-50 px-3 py-2 text-small text-danger">{message(error)}</p> : null}
                {!optionsValid ? <p role="alert" className="rounded-lg bg-danger-50 px-3 py-2 text-small text-danger">{t('optionInvalid')}</p> : null}
                {groups.filter((group) => group.options.length).map((group) => (
                  <EditorSection key={group.key} title={t(`editorSections.${group.key}`)}>
                    {group.options
                      .filter((option) => !(builtin && option.key === 'columns' && layout === 'list'))
                      .map((option) => <OptionRow key={option.key} option={option} value={values[option.key]} onChange={(value) => change(option.key, value)} />)}
                  </EditorSection>
                ))}
                <EditorSection title={t('editorSections.code')} plain>
                  <p className="flex gap-2 rounded-lg bg-warning-50 px-3 py-2 text-[12px] leading-5 text-warning-800 dark:bg-warning-50/10 dark:text-warning-500">
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    {t('customCodeWarning')}
                  </p>
                  <CodeField label={t('headCodeLabel')} help={t('headCodeHelp')} value={headCode} limit={HEAD_CODE_MAX_BYTES} bytes={t('bytes')} placeholder="<style>…</style>" onChange={(next) => { setHeadCode(next); setSuccess(false); }} />
                  <CodeField label={t('contentHtmlLabel')} help={t('contentHtmlHelp')} value={contentHtml} limit={CONTENT_HTML_MAX_BYTES} bytes={t('bytes')} placeholder="<p>…</p>" onChange={(next) => { setContentHtml(next); setSuccess(false); }} />
                </EditorSection>
              </fieldset>
            </aside>
            <section aria-label={t('livePreview')} className="flex min-h-[320px] min-w-0 flex-1 flex-col bg-[var(--polaris-well)]">
              <div className="flex items-center justify-between gap-3 px-5 pt-3 text-[12px] text-[var(--polaris-ink-3)]">
                <span>{t('livePreviewHint')}</span>
                {builtin ? (
                  <Button as="a" size="sm" variant="light" href={`/?preview=${kind}`} target="_blank" rel="noopener noreferrer" startContent={<ExternalLink size={13} />} className="h-7 min-w-0 px-2 text-[12px]">
                    {t('openInNewTab')}
                  </Button>
                ) : null}
              </div>
              <div className="flex min-h-0 flex-1 justify-center overflow-auto p-4 sm:p-5">
                <div
                  className={clsx('flex h-full min-h-[280px] overflow-hidden border border-[var(--polaris-line)] bg-white shadow-[0_1px_3px_rgb(0_0_0/0.06),0_8px_24px_-12px_rgb(0_0_0/0.12)] transition-[width] duration-300 ease-out', viewport === 'desktop' ? 'w-full rounded-xl' : 'rounded-[22px]')}
                  style={width ? { width, maxWidth: '100%' } : undefined}
                >
                  {builtin
                    ? <BuiltinPreview kind={kind} values={draft.values} headCode={draft.headCode} contentHtml={draft.contentHtml} page={page} />
                    : <InstalledPreview page={page} definition={definition} values={draft.values} headCode={draft.headCode} contentHtml={draft.contentHtml} />}
                </div>
              </div>
            </section>
          </div>
        </div>
      </ModalContent>
    </Modal>
  );
}

function EditorSection({ title, children, plain = false }: { title: string; children: ReactNode; plain?: boolean }) {
  return (
    <section className="flex flex-col gap-2.5">
      <h3 className="text-[12px] font-semibold tracking-wide text-[var(--polaris-ink-3)]">{title}</h3>
      <div className={plain ? 'flex flex-col gap-4' : 'divide-y divide-[var(--polaris-line-soft)] rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-card)] shadow-[var(--polaris-shadow-card)]'}>{children}</div>
    </section>
  );
}

function ResetButton({ visible, onPress }: { visible: boolean; onPress: () => void }) {
  const settings = useTranslations('admin.settings');
  if (!visible) return null;
  return (
    <Tooltip content={settings('resetToDefault')} delay={300} closeDelay={0}>
      <Button isIconOnly size="sm" variant="light" aria-label={settings('resetToDefault')} onPress={onPress} className="h-6 w-6 min-w-6 text-[var(--polaris-ink-3)]">
        <RotateCcw size={13} />
      </Button>
    </Tooltip>
  );
}

function OptionRow({ option, value, onChange }: { option: ThemeOption; value: unknown; onChange: (value: unknown) => void }) {
  const t = useTranslations('admin.presentation'),
    themes = useTranslations('admin.themes'),
    message = useApiErrorMessage();
  const current = value ?? option.default;
  const customized = value !== undefined && value !== null;
  const monitors = useOverview(option.type === 'monitor');
  const agents = useFleet(option.type === 'agent');
  const label = (
    <span className="min-w-0">
      <span className="block text-[13px] font-medium text-[var(--polaris-ink)]">{option.label}</span>
      {option.description ? <span className="mt-0.5 block text-[12px] leading-5 text-[var(--polaris-ink-3)]">{option.description}</span> : null}
    </span>
  );
  const reset = <ResetButton visible={customized} onPress={() => onChange(undefined)} />;

  if (option.type === 'boolean')
    return (
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">{label}</div>
        {reset}
        <Switch size="sm" aria-label={option.label} isSelected={current === true} onValueChange={(next) => onChange(next)} />
      </div>
    );

  if (option.type === 'color')
    return (
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">{label}</div>
        {reset}
        <ThemeColorOption compact option={option} value={value} onChange={onChange} />
      </div>
    );

  if (option.type === 'select' && (option.choices?.length ?? 0) <= 4)
    return (
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">{label}</div>
        {reset}
        <Segmented
          label={option.label}
          value={String(current ?? '')}
          onChange={(next) => onChange(next)}
          options={(option.choices ?? []).map((choice) => ({ value: choice, label: option.choiceLabels?.[choice] ?? choice }))}
        />
      </div>
    );

  if (option.type === 'number' && option.min !== undefined && option.max !== undefined) {
    const step = option.step ?? 1;
    const number = typeof current === 'number' ? current : option.min;
    if (step === 1 && option.max - option.min <= 5)
      return (
        <div className="flex items-center gap-3 px-3.5 py-2.5">
          <div className="min-w-0 flex-1">{label}</div>
          {reset}
          <Segmented
            label={option.label}
            value={String(number)}
            onChange={(next) => onChange(Number(next))}
            options={Array.from({ length: option.max - option.min + 1 }, (_, index) => String(option.min! + index)).map((choice) => ({ value: choice, label: choice }))}
          />
        </div>
      );
    return (
      <div className="flex flex-col gap-2 px-3.5 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">{label}</div>
          {reset}
          <NumberField option={option} value={value} onChange={onChange} />
        </div>
        <Slider
          aria-label={option.label}
          size="sm"
          minValue={option.min}
          maxValue={option.max}
          step={step}
          value={Math.min(option.max, Math.max(option.min, number))}
          onChange={(next) => onChange(Array.isArray(next) ? next[0] : next)}
          classNames={{ track: 'cursor-pointer' }}
        />
      </div>
    );
  }

  if (option.type === 'number')
    return (
      <div className="flex items-center gap-3 px-3.5 py-2.5">
        <div className="min-w-0 flex-1">{label}</div>
        {reset}
        <NumberField option={option} value={value} onChange={onChange} />
      </div>
    );

  if (option.type === 'select' || option.type === 'monitor' || option.type === 'agent') {
    const source = option.type === 'monitor' ? monitors : option.type === 'agent' ? agents : null;
    const items = option.type === 'monitor'
      ? (monitors.data?.monitors.filter((item) => Boolean(item.is_public) && Boolean(item.active)).map((item) => ({ key: item.id, label: item.name })) ?? [])
      : option.type === 'agent'
        ? (agents.data?.agents.filter((item) => Boolean(item.is_public) && Boolean(item.active)).map((item) => ({ key: item.id, label: item.name })) ?? [])
        : (option.choices ?? []).map((item) => ({ key: item, label: option.choiceLabels?.[item] ?? item }));
    const error = source?.error ?? null;
    return (
      <div className="flex flex-col gap-2 px-3.5 py-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1">{label}</div>
          {reset}
        </div>
        <Select
          aria-label={option.label}
          size="sm"
          selectedKeys={typeof current === 'string' && items.some((item) => item.key === current) ? [current] : []}
          isLoading={source?.isLoading ?? false}
          isDisabled={!!error}
          onChange={(event) => onChange(event.target.value || undefined)}
        >
          {items.map((item) => <SelectItem key={item.key}>{item.label}</SelectItem>)}
        </Select>
        {source && typeof current === 'string' && !error && source.data && !items.some((item) => item.key === current) ? <p className="text-[12px] text-warning-700">{themes('referenceNotPublic')}</p> : null}
        {error ? (
          <p role="alert" className="flex items-center gap-1 text-[12px] text-danger">
            {message(error)}
            <Button size="sm" variant="light" className="h-6 min-w-0 px-2" onPress={() => void source?.mutate()}>{t('retry')}</Button>
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-3.5 py-3">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">{label}</div>
        {reset}
      </div>
      {option.type === 'textarea'
        ? <Textarea aria-label={option.label} size="sm" minRows={3} value={String(current ?? '')} maxLength={16000} onValueChange={(next) => onChange(next)} />
        : <Input aria-label={option.label} size="sm" type="text" maxLength={2048} value={String(current ?? '')} onValueChange={(next) => onChange(next)} />}
    </div>
  );
}

function NumberField({ option, value, onChange }: { option: ThemeOption; value: unknown; onChange: (value: number | undefined) => void }) {
  const [draft, setDraft] = useState(String(value ?? option.default ?? ''));
  useEffect(() => setDraft(String(value ?? option.default ?? '')), [value, option.default]);
  return (
    <Input
      aria-label={option.label}
      type="number"
      size="sm"
      min={option.min}
      max={option.max}
      step={option.step}
      value={draft}
      classNames={{ base: 'w-[5.5rem]', input: 'text-right tabular-nums' }}
      onValueChange={(next) => {
        setDraft(next);
        onChange(next === '' ? undefined : Number(next));
      }}
    />
  );
}

function CodeField({ label, help, value, limit, bytes, placeholder, onChange }: {
  label: string; help: string; value: string; limit: number; bytes: string; placeholder: string; onChange: (value: string) => void;
}) {
  const size = utf8Length(value);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-[13px] font-medium text-[var(--polaris-ink)]">{label}</span>
        <span className={clsx('text-[11px] tabular-nums', size > limit ? 'text-danger' : 'text-[var(--polaris-ink-4)]')}>{size} / {limit} {bytes}</span>
      </div>
      <Textarea
        aria-label={label}
        value={value}
        minRows={4}
        maxRows={14}
        placeholder={placeholder}
        spellCheck="false"
        isInvalid={size > limit}
        onValueChange={onChange}
        classNames={{ input: 'font-mono text-[12px] leading-5' }}
      />
      <span className="text-[12px] leading-5 text-[var(--polaris-ink-3)]">{help}</span>
    </div>
  );
}

// 内置页面直接加载同源预览页，草稿通过 postMessage 推送，不需要重新加载。
// The built-in page loads the same-origin preview and receives drafts over postMessage without reloading.
function BuiltinPreview({ kind, page, values, headCode, contentHtml }: {
  kind: PageKind; page: PageSettings; values: Record<string, unknown>; headCode: string; contentHtml: string;
}) {
  const t = useTranslations('admin.themes');
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const message = useMemo<PreviewDraft>(() => {
    let view;
    try { view = resolveBuiltinPageView(kind, { ...page, themeOptions: values }); }
    catch { view = resolveBuiltinPageView(kind, { ...page, themeOptions: {} }); }
    return {
      kind,
      view: {
        accent: view.accent, radius: view.radius, width: view.width, density: view.density, layout: view.layout, columns: view.columns,
        showHistory: view.showHistory, showLatency: view.showLatency, showAvailability: view.showAvailability, showExpiry: view.showExpiry, showCountry: view.showCountry,
      },
      headCode,
      contentHtml,
    };
  }, [kind, page, values, headCode, contentHtml]);
  const latest = useRef(message);
  latest.current = message;
  const post = useCallback(() => {
    frame.current?.contentWindow?.postMessage({ type: PREVIEW_DRAFT_MESSAGE, ...latest.current }, window.location.origin);
  }, []);

  useEffect(() => {
    function handle(event: MessageEvent) {
      if (event.source !== frame.current?.contentWindow || event.origin !== window.location.origin) return;
      if (event.data?.type !== PREVIEW_READY_MESSAGE) return;
      post();
      setReady(true);
    }
    window.addEventListener('message', handle);
    return () => window.removeEventListener('message', handle);
  }, [post]);

  // 代码字段可能带脚本，短暂合并连续输入再推送。 / Code may carry scripts, so coalesce rapid typing.
  useEffect(() => {
    if (!ready) return;
    const timer = window.setTimeout(post, 120);
    return () => window.clearTimeout(timer);
  }, [message, ready, post]);

  return (
    <div className="relative flex min-h-0 w-full flex-1">
      {!ready ? <div className="absolute inset-0 flex items-center justify-center text-small text-default-500">{t('previewLoading')}</div> : null}
      <iframe ref={frame} title={t('livePreview')} src={`/?preview=${kind}`} onLoad={post} className={clsx('h-full w-full border-0 bg-white transition-opacity duration-200', ready ? 'opacity-100' : 'opacity-0')} />
    </div>
  );
}

// 安装主题运行在沙箱里，草稿变化后稍等再重载，避免拖动滑块时连续刷新。
// Installed themes run sandboxed and reload after a short pause so dragging a slider does not thrash.
function InstalledPreview({ page, definition, values, headCode, contentHtml }: {
  page: PageSettings; definition: ThemeDefinition; values: Record<string, unknown>; headCode: string; contentHtml: string;
}) {
  const t = useTranslations('admin.themes');
  const message = useApiErrorMessage();
  const [base, setBase] = useState<ThemePreview | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [settled, setSettled] = useState({ values, headCode, contentHtml });
  const theme = page.theme!;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    themesApi.preview(theme.short, theme.version, theme.theme).then((result) => { if (!cancelled) setBase(result); }, (reason: unknown) => { if (!cancelled) setError(reason); });
    return () => { cancelled = true; };
  }, [theme.short, theme.version, theme.theme]);

  useEffect(() => {
    const timer = window.setTimeout(() => setSettled({ values, headCode, contentHtml }), 450);
    return () => window.clearTimeout(timer);
  }, [values, headCode, contentHtml]);

  const preview = useMemo<ThemePreview | null>(() => base && {
    ...base,
    values: Object.fromEntries(definition.options.map((option) => [option.key, settled.values[option.key] ?? option.default ?? null])),
    headCode: settled.headCode,
    contentHtml: settled.contentHtml,
  }, [base, definition.options, settled]);

  if (error) return <p role="alert" className="m-4 text-small text-danger">{message(error)}</p>;
  if (!preview) return <div className="flex w-full items-center justify-center text-small text-default-500">{t('previewLoading')}</div>;
  return <ThemeSandbox preview={preview} className="h-full w-full" />;
}
