import { ApiError } from '@/api/errors';
import { Drawer } from '@/components/ui/MotionOverlays';
import { Button, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader, Input, Switch, Textarea } from '@heroui/react';
import clsx from 'clsx';
import { Download, Eye, EyeOff } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import type { AiChannel, AiChannelDetails, AiChannelInput, AiModel } from '../../../../shared/ai-management';
import { AI_PROTOCOLS, type AiProtocol } from '../../../../shared/ai-probe';
import { DEFAULT_AI_REQUEST, parseAiBody, parseAiHeaders } from '../../../../shared/ai-request';
import { NotificationPolicyControl } from '../notifications/NotificationPolicyControl';
import { ProtocolChip } from './AiParts';
import { aiApi, useRemoteModels } from './api';
import { modelsUrl, PROTOCOL_BASE_URL, PROTOCOL_PATH, requestUrl } from './presentation';
import { useAiError } from './useAiError';
import { HeadersEditor, RequestBodyEditor } from './AiRequestFields';

const INTERVAL_PRESETS = [60, 300, 900, 1800, 3600];

function Editor({ title, subtitle, formId, busy, onClose, children }: { title: string; subtitle?: ReactNode; formId: string; busy: boolean; onClose: () => void; children: ReactNode }) {
  const t = useTranslations('admin.action');
  return (
    <Drawer isOpen placement="right" size="lg" scrollBehavior="inside" isDismissable={!busy} isKeyboardDismissDisabled={busy} onClose={() => !busy && onClose()} classNames={{ base: 'bg-[var(--polaris-canvas)]' }}>
      <DrawerContent>
        <DrawerHeader className="flex flex-col gap-0.5 border-b border-[var(--polaris-line)] pr-12">
          <span className="text-[14px] font-semibold">{title}</span>
          {subtitle ? <span className="flex min-w-0 items-center gap-2 text-[12px] font-normal text-[var(--polaris-ink-3)]">{subtitle}</span> : null}
        </DrawerHeader>
        <DrawerBody className="py-6">{children}</DrawerBody>
        <DrawerFooter className="border-t border-[var(--polaris-line)]">
          <Button variant="light" isDisabled={busy} onPress={onClose}>
            {t('cancel')}
          </Button>
          <Button color="primary" type="submit" form={formId} isLoading={busy}>
            {t('save')}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: ReactNode }) {
  return (
    <section className="flex flex-col gap-4 border-t border-[var(--polaris-line-soft)] pt-5 first:border-t-0 first:pt-0">
      <div>
        <h3 className="text-[13px] font-semibold text-[var(--polaris-ink)]">{title}</h3>
        {hint ? <p className="mt-0.5 text-[12px] leading-5 text-[var(--polaris-ink-3)]">{hint}</p> : null}
      </div>
      {children}
    </section>
  );
}

function FormError({ error, conflict, reload }: { error: string; conflict: boolean; reload: () => void }) {
  const t = useTranslations('admin.ai');
  if (!error) return null;
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-danger/20 bg-danger/[0.04] px-3.5 py-2.5 text-[13px] text-danger-600">
      <p className="min-w-0 flex-1">{error}</p>
      {conflict ? (
        <Button size="sm" variant="light" color="danger" onPress={reload}>
          {t('reloadLatest')}
        </Button>
      ) : null}
    </div>
  );
}

/** Radio cards: the protocol decides the request path, so each card shows it. / 单选卡片：协议决定请求路径，因此每张卡片都显示路径。 */
function ProtocolPicker({ value, onChange, disabled }: { value: AiProtocol; onChange: (value: AiProtocol) => void; disabled: boolean }) {
  const t = useTranslations('admin.ai');
  const label = useId();
  return (
    <div role="radiogroup" aria-labelledby={label} className="flex flex-col gap-2">
      <span id={label} className="text-[13px] font-medium text-[var(--polaris-ink)]">
        {t('protocol')}
      </span>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {AI_PROTOCOLS.map((protocol) => {
          const active = protocol === value;
          return (
            <button
              key={protocol}
              type="button"
              role="radio"
              aria-checked={active}
              disabled={disabled}
              onClick={() => onChange(protocol)}
              className={clsx(
                'flex min-w-0 flex-col items-start gap-1 rounded-xl border px-3 py-2.5 text-left transition-colors disabled:opacity-60',
                active ? 'border-[var(--polaris-ink)] bg-[var(--polaris-card)] shadow-[0_0_0_1px_var(--polaris-ink)]' : 'border-[var(--polaris-line)] bg-[var(--polaris-card)] hover:border-[var(--polaris-line-strong)]',
              )}
            >
              <span className="text-[13px] font-medium text-[var(--polaris-ink)]">{t(protocol)}</span>
              <span className="w-full truncate font-mono text-[11.5px] text-[var(--polaris-ink-3)]">/{PROTOCOL_PATH[protocol]}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function RemoteSuggestions({ channel, value, disabled, onPick }: { channel: AiChannel; value: string; disabled: boolean; onPick: (id: string, name: string | null) => void }) {
  const t = useTranslations('admin.ai');
  const describe = useAiError();
  const [requested, setRequested] = useState(false);
  const remote = useRemoteModels(channel, requested);
  const needle = value.trim().toLowerCase();
  const matches = (remote.data?.models ?? []).filter((item) => !needle || item.id.toLowerCase().includes(needle) || item.name?.toLowerCase().includes(needle)).slice(0, 40);
  if (!requested)
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setRequested(true)}
        className="-mt-2 inline-flex items-center gap-1.5 self-start text-[12px] text-[var(--polaris-ink-2)] underline decoration-[var(--polaris-line-strong)] underline-offset-4 hover:text-[var(--polaris-ink)] hover:decoration-current disabled:opacity-60"
      >
        <Download size={12} />
        {t('fetchRemote')}
      </button>
    );
  if (remote.isLoading) return <p role="status" className="-mt-2 text-[12px] text-[var(--polaris-ink-3)]">{t('remoteLoading')}</p>;
  if (remote.error)
    return (
      <p role="alert" className="-mt-2 flex flex-wrap items-center gap-2 text-[12px] text-danger-600">
        {remote.error instanceof ApiError && remote.error.code === 'ai_models_unavailable' ? t('errors.ai_models_unavailable') : describe(remote.error)}
        <button type="button" className="underline underline-offset-4" onClick={() => void remote.mutate().catch(() => undefined)}>
          {t('refresh')}
        </button>
      </p>
    );
  if (!remote.data) return null;
  return (
    <div className="-mt-2 flex flex-col gap-1.5">
      <p className="text-[12px] text-[var(--polaris-ink-3)]">{t('remoteCount', { shown: matches.length, total: remote.data.models.length })}</p>
      {matches.length ? (
        <div className="flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
          {matches.map((item) => (
            <button
              key={item.id}
              type="button"
              disabled={disabled}
              title={item.name ?? item.id}
              onClick={() => onPick(item.id, item.name)}
              className={clsx(
                'h-6 max-w-full truncate rounded-md border px-2 font-mono text-[11.5px] transition-colors disabled:opacity-60',
                item.id === value.trim()
                  ? 'border-[var(--polaris-ink)] bg-[var(--polaris-ink)] text-[var(--polaris-canvas)]'
                  : 'border-[var(--polaris-line)] bg-[var(--polaris-card)] text-[var(--polaris-ink-2)] hover:border-[var(--polaris-line-strong)]',
              )}
            >
              {item.id}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ChannelEditor({ channel, onClose, onSaved }: { channel: AiChannel | null; onClose: () => void; onSaved: (channel: AiChannel) => void }) {
  const t = useTranslations('admin.ai');
  const describe = useAiError();
  const [current, setCurrent] = useState(channel);
  const [name, setName] = useState(channel?.name ?? '');
  const [baseUrl, setBaseUrl] = useState(channel?.baseUrl ?? '');
  const [notificationIds, setNotificationIds] = useState(channel?.notificationChannelIds ?? []);
  const [notificationEnabled, setNotificationEnabled] = useState(channel?.notificationEnabled !== false);
  const [notificationValid, setNotificationValid] = useState(true);
  const [protocol, setProtocol] = useState<AiProtocol>(channel?.protocol ?? 'openai');
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [replaceKey, setReplaceKey] = useState(false);
  const [headersDraft, setHeadersDraft] = useState<{ revision: string; text: string; valid: boolean } | null>(null);
  const [details, setDetails] = useState<AiChannelDetails | null>(null);
  const [detailsError, setDetailsError] = useState(false);
  const [detailsAttempt, setDetailsAttempt] = useState(0);
  const savedHeaders = current && details?.revision === current.revision ? details.headers : null;
  const headerConflict = Boolean(current && details && details.revision !== current.revision);
  const keyId = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);
  const preview = requestUrl({ baseUrl, protocol });
  const official = PROTOCOL_BASE_URL[protocol];

  useEffect(() => {
    if (!current) return;
    let active = true;
    setDetails(null);
    setDetailsError(false);
    void aiApi.channel(current.id).then(result => { if (active) setDetails(result.channel); }).catch(() => { if (active) setDetailsError(true); });
    return () => { active = false; };
  }, [current?.id, current?.revision, detailsAttempt]);

  const reload = async () => {
    if (!current || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const { channel: latest } = await aiApi.channel(current.id);
      setCurrent(latest);
      setName(latest.name);
      setBaseUrl(latest.baseUrl);
      setProtocol(latest.protocol);
      setNotificationIds(latest.notificationChannelIds);
      setNotificationEnabled(latest.notificationEnabled);
      setApiKey('');
      setShowKey(false);
      setReplaceKey(false);
      setHeadersDraft(null);
      setError('');
      setConflict(false);
    } catch (reason) {
      setError(describe(reason));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (!notificationValid) return;
    if (inFlight.current) return;
    if (headerConflict) { setError(t('errors.revision_conflict')); setConflict(true); return; }
    let headers: Record<string, string> | undefined;
    if (!current || headersDraft?.revision === current.revision) {
      try { headers = parseAiHeaders(JSON.parse(headersDraft?.text ?? '{}')) ?? undefined; } catch {}
      if (!headers || headersDraft?.valid === false) { setError(t('errors.invalid_ai_headers')); return; }
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    setConflict(false);
    const input: AiChannelInput = {
      name: name.trim(),
      baseUrl: baseUrl.trim(),
      protocol,
      notificationChannelIds: notificationIds,
      notificationEnabled,
      ...(!current || replaceKey ? { apiKey } : {}),
      ...(headers ? { headers } : {}),
    };
    try {
      const saved = current ? await aiApi.updateChannel(current.id, { ...input, revision: current.revision }) : await aiApi.createChannel(input);
      setApiKey('');
      onSaved(saved.channel);
    } catch (reason) {
      setError(describe(reason));
      setConflict(reason instanceof ApiError && reason.code === 'revision_conflict');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Editor title={t(current ? 'editChannel' : 'addChannel')} subtitle={current ? <span className="truncate">{current.name}</span> : undefined} formId="ai-channel-form" busy={busy} onClose={onClose}>
      <form id="ai-channel-form" onSubmit={(event) => void save(event)} className="flex flex-col gap-6">
        <Section title={t('sectionConnection')}>
          <Input label={t('channelName')} name="name" value={name} onValueChange={setName} description={t('channelPublicNameHint')} isRequired maxLength={120} isDisabled={busy} autoFocus />
          <ProtocolPicker value={protocol} onChange={setProtocol} disabled={busy} />
          {current && current.protocol !== protocol ? <p className="-mt-2 text-[12px] text-warning-700">{t('protocolChangeHint')}</p> : null}
          <div className="flex flex-col gap-1.5">
            <Input
              label={t('baseUrl')}
              name="baseUrl"
              type="url"
              value={baseUrl}
              onValueChange={setBaseUrl}
              placeholder={official}
              description={t('baseUrlHint', { endpoint: `/${PROTOCOL_PATH[protocol]}` })}
              isRequired
              maxLength={2048}
              isDisabled={busy}
              classNames={{ input: 'font-mono text-[13px]' }}
            />
            <p className="text-[12px] leading-5 text-[var(--polaris-ink-3)]">{t('localEndpointHint')}</p>
            {baseUrl.trim() !== official ? (
              <button type="button" disabled={busy} onClick={() => setBaseUrl(official)} className="self-start text-[12px] text-[var(--polaris-ink-2)] underline decoration-[var(--polaris-line-strong)] underline-offset-4 hover:text-[var(--polaris-ink)] hover:decoration-current disabled:opacity-60">
                {t('useOfficialUrl', { url: official })}
              </button>
            ) : null}
          </div>
          {preview ? (
            <div className="rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-well)] px-3.5 py-3">
              <p className="text-[12px] text-[var(--polaris-ink-3)]">{t('requestPreview')}</p>
              <p className="mt-1.5 break-all font-mono text-[12px] leading-5 text-[var(--polaris-ink)]">
                <span className="mr-1.5 rounded bg-[var(--polaris-active)] px-1 py-px text-[12px] font-semibold text-[var(--polaris-ink-2)]">POST</span>
                {preview}
              </p>
              <p className="mt-1 break-all font-mono text-[12px] leading-5 text-[var(--polaris-ink-2)]">
                <span className="mr-1.5 rounded bg-[var(--polaris-active)] px-1 py-px text-[12px] font-semibold text-[var(--polaris-ink-2)]">GET</span>
                {modelsUrl(baseUrl)}
              </p>
            </div>
          ) : null}
        </Section>

        <Section title={t('sectionAuth')} hint={t('keyHint')}>
          {current ? (
            <Switch size="sm" isSelected={replaceKey} onValueChange={(value) => { setReplaceKey(value); setApiKey(''); }} isDisabled={busy}>
              {t('replaceKey')}
            </Switch>
          ) : null}
          {!current || replaceKey ? (
            <div className="flex flex-col gap-2">
              <label htmlFor={keyId} className="text-[13px] font-medium text-[var(--polaris-ink)]">{t('apiKey')}</label>
              <div className="flex items-start gap-2">
                <Input
                  id={keyId}
                  aria-label={t('apiKey')}
                  name="apiKey"
                  type={showKey ? 'text' : 'password'}
                  autoComplete="new-password"
                  value={apiKey}
                  onValueChange={setApiKey}
                  isRequired
                  maxLength={4096}
                  isDisabled={busy}
                  className="min-w-0 flex-1"
                  classNames={{ input: 'font-mono text-[13px]', inputWrapper: 'h-11 min-h-11', innerWrapper: 'items-center' }}
                />
                <Button type="button" isIconOnly variant="flat" isDisabled={busy} onPress={() => setShowKey(value => !value)} aria-label={t(showKey ? 'hideKey' : 'showKey')} aria-pressed={showKey} className="h-11 w-11 min-w-11 shrink-0 text-[var(--polaris-ink-2)]">
                  {showKey ? <EyeOff size={18} /> : <Eye size={18} />}
                </Button>
              </div>
            </div>
          ) : (
            <p className="text-[12.5px] text-[var(--polaris-ink-3)]">{t('keyUnchanged')}</p>
          )}
        </Section>

        <Section title={t('headers')}>
          {!current || savedHeaders ? <HeadersEditor key={`${current?.id ?? 'new'}:${current?.revision ?? 'new'}`} initialValue={JSON.stringify(savedHeaders ?? {}, null, 2)} disabled={busy} onChange={(text, valid) => setHeadersDraft({ revision: current?.revision ?? 'new', text, valid })} /> : detailsError || headerConflict ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 text-[12.5px] text-danger"><span>{headerConflict ? t('errors.revision_conflict') : t('headersLoadFailed')}</span><Button type="button" size="sm" variant="light" isDisabled={busy} onPress={() => headerConflict ? void reload() : setDetailsAttempt(value => value + 1)}>{t('refresh')}</Button></div>
          ) : <p role="status" className="text-[12.5px] text-[var(--polaris-ink-3)]">{t('headersLoading')}</p>}
        </Section>

        <Section title={t('notifications')}>
          <NotificationPolicyControl enabled={notificationEnabled} ids={notificationIds} onChange={(enabled, ids) => { setNotificationEnabled(enabled); setNotificationIds(ids); }} context={{ monitorType: 'ai', aiChannelId: current?.id }} disabled={busy} onValidityChange={setNotificationValid} />
        </Section>

        <FormError error={error} conflict={conflict} reload={() => void reload()} />
      </form>
    </Editor>
  );
}

export function ModelEditor({
  channel,
  model,
  template,
  onClose,
  onSaved,
}: {
  channel: AiChannel;
  model: AiModel | null;
  /** Settings to copy into a new model; its name and ID are not reused. / 复制到新模型的设置；不沿用名称和模型 ID。 */
  template?: AiModel;
  onClose: () => void;
  onSaved: (model: AiModel) => void;
}) {
  const t = useTranslations('admin.ai');
  const format = useFormatter();
  const describe = useAiError();
  const source = model ?? template;
  const [current, setCurrent] = useState(model);
  const [name, setName] = useState(model?.name ?? (template ? t('copyName', { name: template.name }) : ''));
  const [modelId, setModelId] = useState(model?.modelId ?? '');
  const [prompt, setPrompt] = useState(source?.request?.prompt ?? DEFAULT_AI_REQUEST.prompt);
  const [maxOutputTokens, setMaxOutputTokens] = useState(String(source?.request?.maxOutputTokens ?? DEFAULT_AI_REQUEST.maxOutputTokens));
  const [expectedText, setExpectedText] = useState(source?.request?.expectedText ?? '');
  const [customBody, setCustomBody] = useState(JSON.stringify(source?.request?.body ?? {}, null, 2));
  const [interval, setIntervalValue] = useState(String(source?.intervalSec ?? 300));
  const [timeout, setTimeoutValue] = useState(String((source?.timeoutMs ?? 30000) / 1000));
  const [enabled, setEnabled] = useState(source?.enabled ?? true);
  const [isPublic, setIsPublic] = useState(source?.isPublic ?? false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [conflict, setConflict] = useState(false);
  const inFlight = useRef(false);

  const intervalSec = Number(interval);
  const timeoutSec = Number(timeout);
  const timingValid = Number.isInteger(intervalSec) && intervalSec >= 60 && intervalSec <= 86400 && Number.isInteger(timeoutSec) && timeoutSec >= 1 && timeoutSec <= 60 && timeoutSec < intervalSec;
  const daily = Number.isInteger(intervalSec) && intervalSec >= 60 ? Math.ceil(86400 / intervalSec) : 0;
  const requestChanged = prompt !== DEFAULT_AI_REQUEST.prompt || maxOutputTokens !== String(DEFAULT_AI_REQUEST.maxOutputTokens) || expectedText !== DEFAULT_AI_REQUEST.expectedText || customBody.trim() !== '{}';

  const reload = async () => {
    if (!current || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    try {
      const { model: latest } = await aiApi.model(current.id);
      setCurrent(latest);
      setName(latest.name);
      setModelId(latest.modelId);
      setPrompt(latest.request.prompt);
      setMaxOutputTokens(String(latest.request.maxOutputTokens));
      setExpectedText(latest.request.expectedText);
      setCustomBody(JSON.stringify(latest.request.body ?? {}, null, 2));
      setIntervalValue(String(latest.intervalSec));
      setTimeoutValue(String(latest.timeoutMs / 1000));
      setEnabled(latest.enabled);
      setIsPublic(latest.isPublic);
      setError('');
      setConflict(false);
    } catch (reason) {
      setError(describe(reason));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    if (!timingValid) {
      setError(t('invalidTiming'));
      return;
    }
    let body: Record<string, unknown> | null = null;
    try { body = parseAiBody(JSON.parse(customBody)); } catch {}
    if (!body) { setError(t('invalidJsonObject')); return; }
    inFlight.current = true;
    setBusy(true);
    setError('');
    setConflict(false);
    const input = {
      channelId: channel.id,
      name: name.trim() || modelId.trim(),
      modelId: modelId.trim(),
      intervalSec,
      timeoutMs: timeoutSec * 1000,
      enabled,
      isPublic,
      request: { prompt, maxOutputTokens: Number(maxOutputTokens), expectedText, ...(Object.keys(body).length ? { body } : {}) },
    };
    try {
      const saved = current ? await aiApi.updateModel(current.id, { ...input, revision: current.revision }) : await aiApi.createModel(input);
      onSaved(saved.model);
    } catch (reason) {
      setError(describe(reason));
      setConflict(reason instanceof ApiError && reason.code === 'revision_conflict');
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return (
    <Editor
      title={t(current ? 'editModel' : template ? 'duplicate' : 'addModel')}
      subtitle={
        <>
          <span className="truncate">{channel.name}</span>
          <ProtocolChip protocol={channel.protocol} />
        </>
      }
      formId="ai-model-form"
      busy={busy}
      onClose={onClose}
    >
      <form id="ai-model-form" onSubmit={(event) => void save(event)} className="flex flex-col gap-6">
        <Section title={t('sectionBasics')}>
          <Input
            label={t('modelId')}
            name="modelId"
            value={modelId}
            onValueChange={setModelId}
            isRequired
            maxLength={200}
            isDisabled={busy}
            autoFocus
            spellCheck="false"
            autoComplete="off"
            classNames={{ input: 'font-mono text-[13px]' }}
            pattern={channel.protocol === 'gemini' ? '[A-Za-z0-9][A-Za-z0-9._\\-]*' : undefined}
            description={t(channel.protocol === 'gemini' ? 'geminiModelIdHint' : 'modelIdHint')}
          />
          {channel.protocol === 'gemini' && modelId.trim() ? (
            <p className="-mt-2 break-all font-mono text-[11.5px] text-[var(--polaris-ink-3)]">{requestUrl(channel, modelId.trim())}</p>
          ) : null}
          <RemoteSuggestions
            channel={channel}
            value={modelId}
            disabled={busy}
            onPick={(id, label) => {
              setModelId(id);
              if (!name.trim() && label && label !== id) setName(label);
            }}
          />
          <Input
            label={t('modelName')}
            name="name"
            value={name}
            onValueChange={setName}
            placeholder={modelId.trim() || undefined}
            description={t('modelNameHint')}
            maxLength={120}
            isDisabled={busy}
          />
        </Section>

        <Section title={t('sectionSchedule')}>
          <div className="flex flex-col gap-2">
            <span className="text-[12.5px] text-[var(--polaris-ink-2)]">{t('intervalPresets')}</span>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('intervalPresets')}>
              {INTERVAL_PRESETS.map((seconds) => (
                <button
                  key={seconds}
                  type="button"
                  disabled={busy}
                  aria-pressed={intervalSec === seconds}
                  onClick={() => setIntervalValue(String(seconds))}
                  className={clsx(
                    'h-7 rounded-lg border px-2.5 text-[12px] font-medium transition-colors disabled:opacity-60',
                    intervalSec === seconds
                      ? 'border-[var(--polaris-ink)] bg-[var(--polaris-ink)] text-[var(--polaris-canvas)]'
                      : 'border-[var(--polaris-line)] bg-[var(--polaris-card)] text-[var(--polaris-ink-2)] hover:border-[var(--polaris-line-strong)]',
                  )}
                >
                  {seconds % 3600 === 0 ? t('presetHours', { n: seconds / 3600 }) : t('presetMinutes', { n: seconds / 60 })}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <Input label={t('interval')} name="intervalSec" type="number" value={interval} onValueChange={setIntervalValue} min={60} max={86400} step={1} isRequired isDisabled={busy} />
            <Input
              label={t('timeout')}
              name="timeoutSec"
              type="number"
              value={timeout}
              onValueChange={setTimeoutValue}
              min={1}
              max={60}
              step={1}
              isRequired
              isDisabled={busy}
              isInvalid={timeout !== '' && interval !== '' && !timingValid}
              errorMessage={t('invalidTiming')}
            />
          </div>
          <p className="rounded-xl bg-[var(--polaris-well)] px-3.5 py-2.5 text-[12.5px] leading-5 text-[var(--polaris-ink-2)]">
            {t('dailyEstimate', { count: format.number(daily), month: format.number(daily * 30) })}
          </p>
        </Section>

        <Section title={t('sectionRequest')} hint={t('paidHint')}>
          <Textarea name="prompt" label={t('prompt')} value={prompt} onValueChange={setPrompt} isRequired maxLength={2000} minRows={2} maxRows={6} isDisabled={busy} />
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[9rem_minmax(0,1fr)]">
            <Input name="maxOutputTokens" label={t('maxOutputTokens')} type="number" value={maxOutputTokens} onValueChange={setMaxOutputTokens} min={1} max={4096} step={1} isRequired isDisabled={busy} />
            <Input name="expectedText" label={t('expectedText')} value={expectedText} onValueChange={setExpectedText} maxLength={200} isDisabled={busy} />
          </div>
          <p className="-mt-2 text-[12px] leading-5 text-[var(--polaris-ink-3)]">
            {t('tokensHint')} {t('expectedTextHint')}
          </p>
          <RequestBodyEditor value={customBody} onChange={setCustomBody} disabled={busy} />
          {requestChanged ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setPrompt(DEFAULT_AI_REQUEST.prompt);
                setMaxOutputTokens(String(DEFAULT_AI_REQUEST.maxOutputTokens));
                setExpectedText(DEFAULT_AI_REQUEST.expectedText);
                setCustomBody('{}');
              }}
              className="-mt-2 self-start text-[12px] text-[var(--polaris-ink-2)] underline decoration-[var(--polaris-line-strong)] underline-offset-4 hover:text-[var(--polaris-ink)] hover:decoration-current disabled:opacity-60"
            >
              {t('restoreRequest')}
            </button>
          ) : null}
        </Section>

        <Section title={t('sectionDelivery')}>
          <div className="flex flex-col divide-y divide-[var(--polaris-line-soft)] rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-card)]">
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-[var(--polaris-ink)]">{t('enabled')}</span>
                <span className="block text-[12px] text-[var(--polaris-ink-3)]">{t('enabledHint')}</span>
              </span>
              <Switch size="sm" aria-label={t('enabled')} isSelected={enabled} onValueChange={setEnabled} isDisabled={busy} />
            </div>
            <div className="flex items-center gap-3 px-3.5 py-3">
              <span className="min-w-0 flex-1">
                <span className="block text-[13px] font-medium text-[var(--polaris-ink)]">{t('makePublic')}</span>
                <span className="block text-[12px] text-[var(--polaris-ink-3)]">{t('publicHint')}</span>
              </span>
              <Switch size="sm" aria-label={t('makePublic')} isSelected={isPublic} onValueChange={setIsPublic} isDisabled={busy} />
            </div>
          </div>

        </Section>

        <FormError error={error} conflict={conflict} reload={() => void reload()} />
      </form>
    </Editor>
  );
}
