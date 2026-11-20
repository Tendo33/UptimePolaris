import { useBackendCapabilities } from '@/api/backend';
import { Select } from '@/components/ui/MotionOverlays';
import { Button, Checkbox, Input, SelectItem, Switch, Textarea } from '@heroui/react';
import clsx from 'clsx';
import { ArrowLeft, ArrowRight, Bell, Bot, Check, Clock, Eye, FileJson, Globe, KeyRound, LayoutTemplate, Link2, ListChecks, Search, Server, Upload, X } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import useSWR from 'swr';
import { useFormatter, useTranslations } from 'use-intl';
import { SUBSCRIPTION_LIMITS, selectableSubscriptionItem, subscriptionNotifications, type SubscriptionCatalogEntry, type SubscriptionCategory, type SubscriptionDescriptor, type SubscriptionPreview } from '../../../../shared/subscriptions';
import { stateTone } from '@/components/subscriptions/observation';
import { StatusDot } from '@/components/ui/StatusDot';
import { groupsApi } from '../groups/api';
import { AdminPage } from '../layout/AdminPage';
import { NotificationPolicyControl } from '../notifications/NotificationPolicyControl';
import { usePresentation } from '../settings/presentation-api';
import { subscriptionsApi } from './api';
import { Failure, FieldGroup, IntervalPresets, Note, ParameterFields, SettingRow, Status, Tag, useDraftWarning, useDuration, useSubscriptionError } from './Parts';

const STEPS = ['source', 'parameters', 'preview', 'displayNotifications'] as const;
const PAGE = 50;

export function SubscriptionCreate() {
  const t = useTranslations('admin.subscriptions'), describe = useSubscriptionError(), navigate = useNavigate(), [search] = useSearchParams();
  const format = useFormatter();
  const duration = useDuration();
  const capabilities = useBackendCapabilities().data?.subscriptions;
  const limits = capabilities?.limits ?? SUBSCRIPTION_LIMITS;
  const [groupId, setGroupId] = useState('');
  const groups = useSWR('console:subscription-groups', groupsApi.listGroups, { shouldRetryOnError: false });
  const [step, setStep] = useState(0), [source, setSource] = useState(search.get('source') || 'official');
  const [templateId, setTemplateId] = useState(search.get('template') || 'uptime-kuma');
  const [category, setCategory] = useState<SubscriptionCategory>('website'), [descriptor, setDescriptor] = useState<SubscriptionDescriptor>();
  const [sourceUrl, setSourceUrl] = useState<string | null>(null), [url, setUrl] = useState(''), [json, setJson] = useState('');
  const [parameters, setParameters] = useState<Record<string, string | number | boolean>>({}), [name, setName] = useState('');
  const [intervalSec, setIntervalSec] = useState(60), [staleAfterSec, setStaleAfterSec] = useState(300);
  const [preview, setPreview] = useState<SubscriptionPreview>(), [selected, setSelected] = useState(new Set<string>());
  const [isPublic, setPublic] = useState(false), [autoSubscribe, setAutoSubscribe] = useState(false), [notifications, setNotifications] = useState(subscriptionNotifications);
  const [monitorValid, setMonitorValid] = useState(true), [syncValid, setSyncValid] = useState(true);
  const [query, setQuery] = useState(''), [offset, setOffset] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const [fileName, setFileName] = useState(''), [dragging, setDragging] = useState(false);
  const importedInput = useRef('');
  const [sourceGroup, setSourceGroup] = useState('');
  const lock = useRef(false), requestId = useRef(crypto.randomUUID()), done = useRef(false);
  const feature = usePresentation(), catalog = useSWR(source === 'official' ? 'console:subscription-catalog' : null, subscriptionsApi.catalog, { shouldRetryOnError: false });
  const allowNavigation = useDraftWarning(step > 0 && !done.current);
  useEffect(() => { setOffset(0); }, [query]);
  useEffect(() => { window.scrollTo({ top: 0, behavior: 'smooth' }); }, [step]);

  const act = async (action: () => Promise<void>) => { if (lock.current) return; lock.current = true; setBusy(true); setError(undefined); try { await action(); } catch (cause) { setError(cause); } finally { lock.current = false; setBusy(false); } };
  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > limits.descriptorBytes) { setError(t('errors.subscription_limit_exceeded')); return; }
    try { setJson(await file.text()); setFileName(file.name); setSource('json'); setError(undefined); } catch (cause) { setError(cause); }
  };
  const importSource = () => act(async () => {
    const signature = JSON.stringify([source, templateId, url, json]);
    if (descriptor && importedInput.current === signature) { setStep(1); return; }
    const result = source === 'official' ? await subscriptionsApi.template(templateId) : await subscriptionsApi.import(source === 'link' ? { url } : { descriptor: JSON.parse(json) });
    importedInput.current = signature; void catalog.mutate(); setDescriptor(result.descriptor); setSourceUrl(result.sourceUrl); setName(result.descriptor.name); setParameters({}); setPreview(undefined); setSelected(new Set());
    if (!result.descriptor.categories.includes(category)) setCategory(result.descriptor.categories[0]); setStep(1);
  });
  const readPreview = () => act(async () => {
    const result = await subscriptionsApi.preview({ ...(source === 'official' ? { templateId } : { descriptor, sourceUrl }), parameters });
    setPreview(result.preview); if (result.preview.state === 'failed') { setError(result.preview.error || t('previewFailed')); return; } setStep(2); setSelected(previous => new Set([...previous].filter(id => result.preview.items.some(item => item.sourceItemId === id && selectableSubscriptionItem(item, result.preview.issues)))));
  });
  const create = () => act(async () => {
    const result = await subscriptionsApi.create({ requestId: requestId.current, previewId: preview?.id, category, selectedIds: [...selected], name, intervalSec, staleAfterSec, isPublic, autoSubscribe, notifications, groupId: category === 'website' ? groupId || null : null });
    done.current = true; allowNavigation(); navigate(`/admin/subscriptions/${result.subscription.id}`);
  });

  const visible = preview?.items.filter(item => (!sourceGroup || item.group === sourceGroup) && `${item.name} ${item.group ?? ''} ${item.sourceItemId}`.toLowerCase().includes(query.toLowerCase())) ?? [];
  const selectable = visible.filter(item => preview && selectableSubscriptionItem(item, preview.issues));
  const modelDisabled = category === 'model' && feature.data?.config.aiEnabled !== true;
  const entries: SubscriptionCatalogEntry[] = catalog.data?.entries ?? [{ id: 'uptime-kuma', name: 'Uptime Kuma', description: '', version: '', categories: ['website'], kind: 'template', origin: 'official', path: '', capabilities: [], verifiedAt: null, limitations: [] }];
  const entry = entries.find(item => item.id === templateId);
  const canContinue = source === 'official' ? Boolean(templateId) : source === 'link' ? Boolean(url.trim()) : Boolean(json.trim());
  const intervalOptions = [60, 300, 900, 3600].filter(value => value >= limits.minimumIntervalSec && value <= limits.maximumIntervalSec);

  const primary = step === 0 ? (
    <Button color="primary" isLoading={busy} isDisabled={!canContinue} endContent={busy ? undefined : <ArrowRight size={15} />} onPress={() => void importSource()}>{t('continue')}</Button>
  ) : step === 1 ? (
    <Button color="primary" isLoading={busy} endContent={busy ? undefined : <ArrowRight size={15} />} onPress={() => void readPreview()}>{busy ? t('reading') : t('readPreview')}</Button>
  ) : step === 2 ? (
    <Button color="primary" isDisabled={!selected.size} endContent={<ArrowRight size={15} />} onPress={() => setStep(3)}>{t('continue')}</Button>
  ) : (
    <Button color="primary" isLoading={busy} isDisabled={!name.trim() || modelDisabled || !monitorValid || !syncValid} startContent={busy ? undefined : <Check size={15} />} onPress={() => void create()}>{t('create')}</Button>
  );

  return (
    <AdminPage title={t('add')} description={t('createDescription')} back={{ href: '/admin/subscriptions', label: t('mine') }}>
      <Stepper step={step} onJump={index => { if (!busy && index < step) setStep(index); }} />

      <div className="grid items-start gap-5 pb-8 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0 space-y-5">
          <Failure error={error} className="" />

          {step === 0 ? (
            <>
              <FieldGroup title={t('category')} icon={<ListChecks />}>
                <ChoiceGroup label={t('category')} value={category} onChange={value => setCategory(value as SubscriptionCategory)} disabled={busy} columns={2} options={[
                  { value: 'website', icon: <Globe size={18} />, title: t('website'), hint: t('categoryWebsiteHint') },
                  { value: 'model', icon: <Bot size={18} />, title: t('model'), hint: t('categoryModelHint'), badge: feature.data?.config.aiEnabled === false ? t('aiOff') : undefined },
                ]} />
              </FieldGroup>

              <FieldGroup title={t('source')} icon={<Server />}>
                <ChoiceGroup label={t('source')} value={source} onChange={setSource} disabled={busy} columns={3} options={[
                  { value: 'official', icon: <LayoutTemplate size={18} />, title: t('sourceOfficial'), hint: t('sourceOfficialHint') },
                  { value: 'link', icon: <Link2 size={18} />, title: t('link'), hint: t('sourceLinkHint') },
                  { value: 'json', icon: <FileJson size={18} />, title: t('json'), hint: t('sourceJsonHint') },
                ]} />

                {source === 'official' ? (
                  <div className="space-y-3 border-t border-[var(--polaris-line-soft)] pt-4">
                    <Failure error={catalog.error} retry={() => void catalog.mutate()} className="" />
                    <Select label={t('template')} labelPlacement="outside" placeholder={t('template')} selectedKeys={[templateId]} isLoading={!catalog.data && !catalog.error} isDisabled={busy} onChange={event => event.target.value && setTemplateId(event.target.value)}>
                      {entries.map(item => <SelectItem key={item.id} textValue={item.name} description={item.description || undefined}>{item.name}</SelectItem>)}
                    </Select>
                    {entry?.version ? (
                      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-[var(--polaris-ink-3)]">
                        <Tag className="polaris-num">v{entry.version}</Tag>
                        {entry.categories.map(value => <Tag key={value}>{t(value)}</Tag>)}
                        {!entry.categories.includes(category) ? <Tag tone="warning">{t('errors.subscription_category_invalid')}</Tag> : null}
                      </div>
                    ) : null}
                    <Link to="/admin/subscriptions/library" className="inline-flex items-center gap-1 text-[12.5px] text-[var(--polaris-ink-2)] underline underline-offset-4 hover:text-[var(--polaris-ink)]">{t('browse')}<ArrowRight size={13} /></Link>
                  </div>
                ) : source === 'link' ? (
                  <div className="border-t border-[var(--polaris-line-soft)] pt-4">
                    <Input label={t('configUrl')} labelPlacement="outside" type="url" value={url} onValueChange={setUrl} isDisabled={busy} placeholder="https://…/subscription.json" startContent={<Link2 size={14} className="shrink-0 text-[var(--polaris-ink-4)]" />} classNames={{ input: 'font-mono text-[12.5px]' }} description={t('sourceLinkHint')} />
                  </div>
                ) : (
                  <div className="space-y-3 border-t border-[var(--polaris-line-soft)] pt-4">
                    <label
                      onDragOver={event => { event.preventDefault(); setDragging(true); }}
                      onDragLeave={() => setDragging(false)}
                      onDrop={event => { event.preventDefault(); setDragging(false); void readFile(event.dataTransfer.files[0]); }}
                      className={clsx('flex cursor-pointer flex-col items-center justify-center gap-1.5 rounded-xl border border-dashed px-4 py-6 text-center transition-colors', dragging ? 'border-primary bg-primary/[0.04]' : 'border-[var(--polaris-line)] hover:bg-[var(--polaris-hover)]', busy && 'pointer-events-none opacity-60')}
                    >
                      <Upload size={20} className="text-[var(--polaris-ink-3)]" aria-hidden="true" />
                      <span className="text-[13px] font-medium text-[var(--polaris-ink)]">{fileName || t('upload')}</span>
                      <span className="text-[12px] text-[var(--polaris-ink-4)]">{t('dropHint', { size: format.number(limits.descriptorBytes / 1024, { maximumFractionDigits: 0 }) })}</span>
                      <input type="file" accept="application/json,.json" disabled={busy} onChange={event => void readFile(event.target.files?.[0])} className="sr-only" />
                    </label>
                    <Textarea label={t('descriptor')} labelPlacement="outside" placeholder='{ "name": "…" }' value={json} onValueChange={value => { setJson(value); setFileName(''); }} minRows={10} maxRows={22} isDisabled={busy} spellCheck="false" classNames={{ input: 'font-mono text-[12.5px] leading-relaxed' }} />
                  </div>
                )}
              </FieldGroup>
            </>
          ) : null}

          {step === 1 && descriptor ? (
            <>
              <FieldGroup title={t('parameters')} icon={<KeyRound />} description={`${descriptor.name} · v${descriptor.version}`}>
                <ParameterFields descriptor={descriptor} parameters={parameters} onChange={value => { setParameters(value); setPreview(undefined); }} disabled={busy} />
              </FieldGroup>

              <FieldGroup title={t('syncSettings')} icon={<Clock />}>
                <div className="grid gap-5 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Input type="number" labelPlacement="outside" min={limits.minimumIntervalSec} max={limits.maximumIntervalSec} label={t('interval')} value={String(intervalSec)} onValueChange={value => setIntervalSec(Number(value))} isDisabled={busy} />
                    {intervalOptions.length ? <IntervalPresets value={intervalSec} onChange={setIntervalSec} options={intervalOptions} disabled={busy} /> : null}
                  </div>
                  <div className="space-y-2">
                    <Input type="number" labelPlacement="outside" min={60} max={604800} label={t('staleAfter')} value={String(staleAfterSec)} onValueChange={value => setStaleAfterSec(Number(value))} isDisabled={busy} />
                    <IntervalPresets value={staleAfterSec} onChange={setStaleAfterSec} options={[300, 900, 3600, 86400]} disabled={busy} />
                    <p className="text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">{descriptor.observations.mode === 'heartbeat' ? t('heartbeatExpiryHint') : t('snapshotExpiryHint')}</p>
                  </div>
                </div>
              </FieldGroup>

              <FieldGroup title={t('requestTargets')} icon={<Server />}>
                <ul className="space-y-1.5">
                  {Object.entries(descriptor.requests).map(([key, request]) => (
                    <li key={key} className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--polaris-well)] px-3 py-2">
                      <span className="shrink-0 rounded bg-[var(--polaris-card)] px-1.5 font-mono text-[12px] font-semibold text-[var(--polaris-ink-2)] ring-1 ring-[var(--polaris-line)]">{request.method}</span>
                      <code className="min-w-0 break-all font-mono text-[12px] text-[var(--polaris-ink-2)]">{String(parameters[request.baseUrlInput] ?? descriptor.inputs[request.baseUrlInput]?.default ?? '{' + request.baseUrlInput + '}')}{request.path}</code>
                    </li>
                  ))}
                </ul>
                <Note>{t('readOnlyPreview')}</Note>
              </FieldGroup>
            </>
          ) : null}

          {step === 2 && preview ? (
            <FieldGroup
              title={t('selectItems')}
              icon={<ListChecks />}
              actions={<><Status value={preview.state} /><Tag className="polaris-num">{t('selectedCount', { count: selected.size })}</Tag></>}
            >
              {preview.issues.length ? (
                <Note tone="warn">
                  <details>
                    <summary className="cursor-pointer font-medium">{t('previewIssues', { count: preview.issues.length })}</summary>
                    <ul className="mt-2 space-y-1">
                      {preview.issues.map((issue, index) => <li key={index} className="break-words"><span className="font-mono text-[11.5px]">{issue.itemId || issue.requestId} · {issue.path}</span> · {describe(new Error(issue.code))}</li>)}
                    </ul>
                  </details>
                </Note>
              ) : null}

              <div className="flex flex-wrap items-center gap-2">
                <Input size="sm" className="min-w-48 flex-1" aria-label={t('search')} placeholder={t('searchItems')} value={query} onValueChange={setQuery} startContent={<Search size={14} className="shrink-0 text-[var(--polaris-ink-4)]" />} endContent={query ? <button type="button" aria-label={t('cancel')} onClick={() => setQuery('')} className="text-[var(--polaris-ink-4)] hover:text-[var(--polaris-ink)]"><X size={14} /></button> : null} />
                {new Set(preview.items.map(item => item.group).filter(Boolean)).size > 1 ? (
                  <Select className="w-full sm:w-48" size="sm" aria-label={t('group')} selectedKeys={[sourceGroup]} onChange={event => { setSourceGroup(event.target.value); setOffset(0); }}>
                    {['', ...new Set(preview.items.map(item => item.group).filter((value): value is string => !!value))].map(group => <SelectItem key={group}>{group || t('allGroups')}</SelectItem>)}
                  </Select>
                ) : null}
              </div>

              <div className="overflow-hidden rounded-xl border border-[var(--polaris-line)]">
                <div className="flex items-center gap-3 border-b border-[var(--polaris-line-soft)] bg-[var(--polaris-well)] px-3 py-2 text-[12px] text-[var(--polaris-ink-3)]">
                  <Checkbox
                    size="sm"
                    aria-label={t('selectFiltered')}
                    isSelected={selectable.length > 0 && selectable.every(item => selected.has(item.sourceItemId))}
                    isIndeterminate={selectable.some(item => selected.has(item.sourceItemId)) && !selectable.every(item => selected.has(item.sourceItemId))}
                    isDisabled={!selectable.length}
                    onValueChange={on => setSelected(previous => { const next = new Set(previous); for (const item of selectable) { if (on) next.add(item.sourceItemId); else next.delete(item.sourceItemId); } return next; })}
                  />
                  <span className="polaris-num">{t('previewCounts', { shown: visible.length, selectable: selectable.length })}</span>
                  {selected.size ? <button type="button" onClick={() => setSelected(new Set())} className="ml-auto underline underline-offset-4 hover:text-[var(--polaris-ink)]">{t('clearSelection')}</button> : null}
                </div>
                {visible.length ? (
                  <ul className="max-h-[32rem] divide-y divide-[var(--polaris-line-soft)] overflow-auto">
                    {visible.slice(offset, offset + PAGE).map(item => {
                      const ok = selectableSubscriptionItem(item, preview.issues);
                      const status = item.observation?.status || 'unknown';
                      return (
                        <li key={item.sourceItemId} className={clsx('flex items-center gap-3 px-3 py-2.5 transition-colors', ok ? 'hover:bg-[var(--polaris-hover)]' : 'opacity-55')}>
                          <Checkbox size="sm" aria-label={t('selectItem', { name: item.name })} isDisabled={!ok} isSelected={selected.has(item.sourceItemId)} onValueChange={value => setSelected(previous => { const next = new Set(previous); if (value) next.add(item.sourceItemId); else next.delete(item.sourceItemId); return next; })} />
                          <StatusDot tone={stateTone(status)} size={7} />
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13px] font-medium text-[var(--polaris-ink)]">{item.name}</p>
                            <p className="truncate text-[11.5px] text-[var(--polaris-ink-4)]">{item.group || item.modelId || item.sourceItemId}{!ok ? ` · ${t('notSelectable')}` : ''}</p>
                          </div>
                          {item.observation?.latencyMs != null ? <span className="polaris-num hidden text-[12px] text-[var(--polaris-ink-3)] sm:block">{format.number(item.observation.latencyMs)} ms</span> : null}
                          <Status value={status} className="w-20 justify-end text-[12px]" />
                        </li>
                      );
                    })}
                  </ul>
                ) : <p className="px-4 py-8 text-center text-[13px] text-[var(--polaris-ink-3)]">{t('noResults')}</p>}
              </div>
              {visible.length > PAGE ? (
                <div className="flex items-center justify-end gap-2 text-[12px] text-[var(--polaris-ink-3)]">
                  <span className="polaris-num">{offset + 1}–{Math.min(offset + PAGE, visible.length)} / {visible.length}</span>
                  <Button size="sm" variant="light" isDisabled={!offset} onPress={() => setOffset(offset - PAGE)}>{t('previousPage')}</Button>
                  <Button size="sm" variant="light" isDisabled={offset + PAGE >= visible.length} onPress={() => setOffset(offset + PAGE)}>{t('next')}</Button>
                </div>
              ) : null}
            </FieldGroup>
          ) : null}

          {step === 3 ? (
            <>
              <FieldGroup title={t('basics')} icon={<Eye />} description={t('basicsHint')}>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Input label={t('name')} labelPlacement="outside" placeholder={descriptor?.name} value={name} onValueChange={setName} isRequired maxLength={120} isDisabled={busy} />
                  {category === 'website' ? (
                    <Select label={t('group')} labelPlacement="outside" placeholder={t('noGroup')} selectedKeys={groupId ? [groupId] : []} onChange={event => setGroupId(event.target.value)} isDisabled={busy || !groups.data}>
                      {(groups.data?.groups ?? []).map(group => <SelectItem key={group.id}>{group.name}</SelectItem>)}
                    </Select>
                  ) : null}
                </div>
                <SettingRow title={t('publishSelected')} hint={t('publishSelectedHint')}>
                  <Switch size="sm" aria-label={t('publishSelected')} isSelected={isPublic} onValueChange={setPublic} isDisabled={busy} />
                </SettingRow>
                <SettingRow title={t('autoSubscribe')} hint={t('autoSubscribeHint')}>
                  <Switch size="sm" aria-label={t('autoSubscribe')} isSelected={autoSubscribe} onValueChange={setAutoSubscribe} isDisabled={busy} />
                </SettingRow>
              </FieldGroup>

              {(['monitor', 'sync'] as const).map(kind => (
                <FieldGroup key={kind} title={t(kind === 'monitor' ? 'monitorAlerts' : 'syncAlerts')} icon={<Bell />} description={t(kind === 'monitor' ? 'monitorAlertsHint' : 'syncAlertsHint')}>
                  <NotificationPolicyControl enabled={notifications[kind].notificationEnabled} ids={notifications[kind].notificationChannelIds} disabled={busy} onValidityChange={kind === 'monitor' ? setMonitorValid : setSyncValid} onChange={(notificationEnabled, notificationChannelIds) => setNotifications(previous => ({ ...previous, [kind]: { ...previous[kind], notificationEnabled, notificationChannelIds } }))} context={{ sourceType: 'subscription', groupId: kind === 'monitor' && category === 'website' ? groupId || null : null, eventKind: kind === 'sync' ? 'subscription_sync' : category === 'model' ? 'ai_state' : 'monitor_state' }} />
                  {kind === 'sync' && notifications.sync.notificationEnabled ? (
                    <Input type="number" labelPlacement="outside" className="max-w-xs" min={60} max={86400} label={t('syncDelay')} value={String(notifications.sync.afterSec)} onValueChange={value => setNotifications(previous => ({ ...previous, sync: { ...previous.sync, afterSec: Number(value) } }))} />
                  ) : null}
                </FieldGroup>
              ))}

              {modelDisabled ? <Note tone="warn">{t('enableAI')} <Link to="/admin/settings" className="font-medium underline underline-offset-4">{t('settings')}</Link></Note> : null}
            </>
          ) : null}

          <div className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom,0px))] z-20 flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--polaris-line)] bg-[var(--polaris-card)] px-4 py-3 shadow-[0_10px_30px_-16px_rgb(0_0_0/0.35)] lg:bottom-3">
            {step > 0 ? <Button variant="light" isDisabled={busy} startContent={<ArrowLeft size={15} />} onPress={() => setStep(step - 1)}>{t('previous')}</Button> : null}
            <span className="hidden min-w-0 flex-1 truncate text-[12.5px] text-[var(--polaris-ink-3)] sm:block">
              {step === 3 ? t('createSummary', { count: selected.size, category: t(category), seconds: intervalSec }) : t('stepOf', { step: step + 1, total: STEPS.length })}
            </span>
            <div className="ml-auto">{primary}</div>
          </div>
        </div>

        <aside className="polaris-card hidden p-5 lg:sticky lg:top-4 lg:block">
          <p className="mb-3 text-[13px] font-semibold text-[var(--polaris-ink)]">{t('summary')}</p>
          <dl className="space-y-2.5 text-[12.5px]">
            {[
              [t('category'), t(category)],
              [t('source'), source === 'official' ? entry?.name ?? templateId : source === 'link' ? t('link') : fileName || t('json')],
              [t('descriptor'), descriptor ? `${descriptor.name} v${descriptor.version}` : null],
              [t('intervalShort'), step > 0 ? duration(intervalSec) : null],
              [t('selectItems'), preview ? t('selectedCount', { count: selected.size }) : null],
            ].map(([label, value]) => (
              <div key={label} className="flex items-baseline justify-between gap-3">
                <dt className="shrink-0 text-[var(--polaris-ink-3)]">{label}</dt>
                <dd className={clsx('min-w-0 truncate text-right', value ? 'font-medium text-[var(--polaris-ink)]' : 'text-[var(--polaris-ink-4)]')}>{value || '—'}</dd>
              </div>
            ))}
          </dl>
          <p className="mt-4 border-t border-[var(--polaris-line-soft)] pt-3 text-[12px] leading-relaxed text-[var(--polaris-ink-4)]">{t('readOnlyPreview')}</p>
        </aside>
      </div>
    </AdminPage>
  );
}

function Stepper({ step, onJump }: { step: number; onJump: (index: number) => void }) {
  const t = useTranslations('admin.subscriptions');
  return (
    <ol aria-label={t('createSteps')} className="mb-6 flex items-center gap-2 overflow-x-auto pb-1">
      {STEPS.map((key, index) => {
        const doneStep = index < step, current = index === step;
        return (
          <li key={key} className="flex min-w-0 shrink-0 items-center gap-2 sm:flex-1">
            <button
              type="button"
              disabled={!doneStep}
              aria-current={current ? 'step' : undefined}
              onClick={() => onJump(index)}
              className={clsx('flex min-w-0 items-center gap-2 rounded-lg py-1 pr-2 text-left text-[13px] transition-colors', doneStep && 'hover:text-[var(--polaris-ink)]', current ? 'font-semibold text-[var(--polaris-ink)]' : doneStep ? 'text-[var(--polaris-ink-2)]' : 'text-[var(--polaris-ink-4)]')}
            >
              <span className={clsx('polaris-num flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[11.5px] font-semibold transition-colors', current ? 'bg-[var(--polaris-ink)] text-[var(--polaris-card)]' : doneStep ? 'bg-success/15 text-success-700' : 'border border-[var(--polaris-line)] text-[var(--polaris-ink-4)]')}>
                {doneStep ? <Check size={13} strokeWidth={2.5} /> : index + 1}
              </span>
              <span className="truncate">{t(key)}</span>
            </button>
            {index < STEPS.length - 1 ? <span aria-hidden="true" className={clsx('hidden h-px flex-1 sm:block', doneStep ? 'bg-success/40' : 'bg-[var(--polaris-line)]')} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function ChoiceGroup({ label, value, onChange, options, columns, disabled }: { label: string; value: string; onChange: (value: string) => void; options: Array<{ value: string; icon: ReactNode; title: string; hint: string; badge?: string }>; columns: 2 | 3; disabled?: boolean }) {
  return (
    <div role="radiogroup" aria-label={label} className={clsx('grid gap-3', columns === 2 ? 'sm:grid-cols-2' : 'sm:grid-cols-3')}>
      {options.map(option => {
        const on = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={on}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={clsx(
              'relative flex items-start gap-3 rounded-xl border p-3.5 text-left transition-[border-color,background-color,box-shadow] disabled:opacity-60',
              on ? 'border-[var(--polaris-ink)] bg-[var(--polaris-hover)] shadow-[0_0_0_1px_var(--polaris-ink)]' : 'border-[var(--polaris-line)] hover:border-[var(--polaris-ink-4)] hover:bg-[var(--polaris-hover)]',
            )}
          >
            <span className={clsx('flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] border transition-colors', on ? 'border-transparent bg-[var(--polaris-ink)] text-[var(--polaris-card)]' : 'border-[var(--polaris-line)] bg-[var(--polaris-card)] text-[var(--polaris-ink-2)]')}>{option.icon}</span>
            <span className="min-w-0 flex-1">
              <span className="flex flex-wrap items-center gap-1.5 text-[13.5px] font-medium text-[var(--polaris-ink)]">
                {option.title}
                {option.badge ? <Tag tone="warning">{option.badge}</Tag> : null}
              </span>
              <span className="mt-0.5 block text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">{option.hint}</span>
            </span>
            {on ? <Check size={15} strokeWidth={2.5} className="absolute top-3 right-3 text-[var(--polaris-ink)]" aria-hidden="true" /> : null}
          </button>
        );
      })}
    </div>
  );
}
