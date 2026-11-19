import { Button, Checkbox, Input, Radio, RadioGroup, SelectItem, Switch, Textarea } from '@heroui/react';
import { Select } from '@/components/ui/MotionOverlays';
import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import useSWR from 'swr';
import { useTranslations } from 'use-intl';
import { useBackendCapabilities } from '@/api/backend';
import { SUBSCRIPTION_LIMITS, selectableSubscriptionItem, subscriptionNotifications, type SubscriptionCategory, type SubscriptionDescriptor, type SubscriptionPreview } from '../../../../shared/subscriptions';
import { groupsApi } from '../groups/api';
import { AdminPage } from '../layout/AdminPage';
import { NotificationPolicyControl } from '../notifications/NotificationPolicyControl';
import { usePresentation } from '../settings/presentation-api';
import { subscriptionsApi } from './api';
import { CategorySwitch, Failure, FieldGroup, ParameterFields, Status, useDraftWarning, useSubscriptionError } from './Parts';

export function SubscriptionCreate() {
  const t = useTranslations('admin.subscriptions'), describe = useSubscriptionError(), navigate = useNavigate(), [search] = useSearchParams();
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
  const importedInput = useRef('');
  const [sourceGroup, setSourceGroup] = useState('');
  const lock = useRef(false), requestId = useRef(crypto.randomUUID()), done = useRef(false);
  const feature = usePresentation(), catalog = useSWR(source === 'official' ? 'console:subscription-catalog' : null, subscriptionsApi.catalog, { shouldRetryOnError: false });
  const allowNavigation = useDraftWarning(step > 0 && !done.current);
  useEffect(() => { setOffset(0); }, [query]);
  const act = async (action: () => Promise<void>) => { if (lock.current) return; lock.current = true; setBusy(true); setError(undefined); try { await action(); } catch (error) { setError(error); } finally { lock.current = false; setBusy(false); } };
  const readFile = async (event: ChangeEvent<HTMLInputElement>) => { const file = event.target.files?.[0]; if (!file) return; if (file.size > limits.descriptorBytes) { setError(t('errors.subscription_limit_exceeded')); return; } try { setJson(await file.text()); setSource('json'); } catch (error) { setError(error); } };
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
  const modelDisabled = category === 'model' && feature.data?.config.aiEnabled !== true;
  return <AdminPage title={t('add')} back={{ href: '/admin/subscriptions', label: t('mine') }}>
    <ol aria-label={t('createSteps')} className="mb-7 grid grid-cols-2 gap-3 sm:grid-cols-4">{['source', 'parameters', 'preview', 'displayNotifications'].map((key, index) => <li key={key} aria-current={index === step ? 'step' : undefined} className={`flex items-center gap-2 text-small ${index === step ? 'font-semibold text-primary' : 'text-default-500'}`}><span className="flex h-7 w-7 items-center justify-center rounded-full bg-default-100 tabular-nums">{index + 1}</span>{t(key)}</li>)}</ol>
    <div className="max-w-4xl space-y-6 pb-8"><Failure error={error} />
      {step === 0 ? <>
        <CategorySwitch value={category} onChange={value => setCategory(value as SubscriptionCategory)} />
        <RadioGroup label={t('source')} orientation="horizontal" value={source} isDisabled={busy} onValueChange={setSource}>{['official', 'link', 'json'].map(value => <Radio key={value} value={value}>{t(value)}</Radio>)}</RadioGroup>
        {source === 'official' ? <><Failure error={catalog.error} retry={() => void catalog.mutate()} /><Select label={t('template')} selectedKeys={[templateId]} isDisabled={busy} onChange={event => setTemplateId(event.target.value)}>{(catalog.data?.entries ?? [{ id: 'uptime-kuma', name: 'Uptime Kuma' }]).map(entry => <SelectItem key={entry.id}>{entry.name}</SelectItem>)}</Select><Link to="/admin/subscriptions/library" className="inline-block text-small text-primary underline">{t('browse')}</Link></> : source === 'link' ? <Input label={t('configUrl')} type="url" value={url} onValueChange={setUrl} isDisabled={busy} placeholder="https://…/subscription.json" /> : <><label className="block space-y-2 text-small"><span>{t('upload')}</span><input type="file" accept="application/json,.json" disabled={busy} onChange={event => void readFile(event)} className="block w-full rounded-medium border border-divider p-3" /></label><Textarea label={t('descriptor')} value={json} onValueChange={setJson} minRows={12} maxRows={24} isDisabled={busy} spellCheck="false" classNames={{ input: 'font-mono text-small' }} /></>}
        <Button color="primary" isLoading={busy} onPress={() => void importSource()}>{t('continue')}</Button>
      </> : null}
      {step === 1 && descriptor ? <>
        <FieldGroup title={t('parameters')}><ParameterFields descriptor={descriptor} parameters={parameters} onChange={value => { setParameters(value); setPreview(undefined); }} disabled={busy} /></FieldGroup>
        <div className="grid gap-4 sm:grid-cols-2"><Input type="number" min={limits.minimumIntervalSec} max={limits.maximumIntervalSec} label={t('interval')} value={String(intervalSec)} onValueChange={value => setIntervalSec(Number(value))} isDisabled={busy} /><Input type="number" min={60} max={604800} label={t('staleAfter')} description={descriptor.observations.mode === 'heartbeat' ? t('heartbeatExpiryHint') : t('snapshotExpiryHint')} value={String(staleAfterSec)} onValueChange={value => setStaleAfterSec(Number(value))} isDisabled={busy} /></div>
        <FieldGroup title={t('requestTargets')}><ul className="space-y-1 text-small text-default-500">{Object.entries(descriptor.requests).map(([key, request]) => <li key={key} className="break-all"><code>{request.method} {String(parameters[request.baseUrlInput] ?? descriptor.inputs[request.baseUrlInput]?.default ?? '{' + request.baseUrlInput + '}')}{request.path}</code></li>)}</ul></FieldGroup><p className="text-small text-default-500">{t('readOnlyPreview')}</p>
        <div className="flex gap-3"><Button variant="flat" isDisabled={busy} onPress={() => setStep(0)}>{t('previous')}</Button><Button color="primary" isLoading={busy} onPress={() => void readPreview()}>{busy ? t('reading') : t('readPreview')}</Button></div>
      </> : null}
      {step === 2 && preview ? <>
        <div className="flex flex-wrap items-center gap-3"><h2 className="font-semibold">{t('selectItems')}</h2><Status value={preview.state} /><span className="text-small text-default-500">{t('selectedCount', { count: selected.size })}</span></div>
        {preview.issues.length ? <details className="rounded-medium bg-warning-50 p-4 text-small"><summary className="cursor-pointer">{t('previewIssues', { count: preview.issues.length })}</summary><ul className="mt-3 space-y-2">{preview.issues.map((issue, index) => <li key={index}>{issue.itemId || issue.requestId} · {issue.path} · {describe(new Error(issue.code))}</li>)}</ul></details> : null}
        <div className="flex flex-wrap gap-3"><Input className="min-w-48 flex-1" size="sm" aria-label={t('search')} placeholder={t('search')} value={query} onValueChange={setQuery} /><Select className="w-48" size="sm" aria-label={t('group')} selectedKeys={[sourceGroup]} onChange={event => { setSourceGroup(event.target.value); setOffset(0); }}>{['', ...new Set(preview.items.map(item => item.group).filter((value): value is string => !!value))].map(group => <SelectItem key={group}>{group || t('all')}</SelectItem>)}</Select></div>
        <div className="flex gap-3"><Button size="sm" variant="flat" onPress={() => setSelected(new Set(visible.filter(item => selectableSubscriptionItem(item, preview.issues)).map(item => item.sourceItemId)))}>{t('selectFiltered')}</Button><Button size="sm" variant="light" onPress={() => setSelected(new Set())}>{t('clearSelection')}</Button></div>
        <ul className="divide-y divide-divider">{visible.slice(offset, offset + 50).map(item => <li key={item.sourceItemId} className="flex items-center gap-4 py-3"><Checkbox isDisabled={!selectableSubscriptionItem(item, preview.issues)} isSelected={selected.has(item.sourceItemId)} onValueChange={value => setSelected(previous => { const next = new Set(previous); value ? next.add(item.sourceItemId) : next.delete(item.sourceItemId); return next; })}><span className="text-small font-medium">{item.name}</span></Checkbox><span className="flex-1 text-small text-default-500">{item.group || item.modelId}</span><Status value={item.observation?.status || 'unknown'} /></li>)}</ul>
        {visible.length > 50 ? <div className="flex gap-2"><Button size="sm" isDisabled={!offset} onPress={() => setOffset(offset - 50)}>{t('previous')}</Button><Button size="sm" isDisabled={offset + 50 >= visible.length} onPress={() => setOffset(offset + 50)}>{t('next')}</Button></div> : null}
        <div className="flex gap-3"><Button variant="flat" onPress={() => setStep(1)}>{t('previous')}</Button><Button color="primary" isDisabled={!selected.size} onPress={() => setStep(3)}>{t('continue')}</Button></div>
      </> : null}
      {step === 3 ? <>
        <Input label={t('name')} value={name} onValueChange={setName} isRequired maxLength={120} isDisabled={busy} />
        <>{category === 'website' ? <Select label={t('group')} selectedKeys={groupId ? [groupId] : []} onChange={event => setGroupId(event.target.value)} isDisabled={busy || !groups.data}>{(groups.data?.groups ?? []).map(group => <SelectItem key={group.id}>{group.name}</SelectItem>)}</Select> : null}</><Switch isSelected={isPublic} onValueChange={setPublic} isDisabled={busy}>{t('publishSelected')}</Switch>
        <Switch isSelected={autoSubscribe} onValueChange={setAutoSubscribe} isDisabled={busy}>{t('autoSubscribe')}</Switch><p className="text-small text-default-500">{t('autoSubscribeHint')}</p>
        {(['monitor', 'sync'] as const).map(kind => <FieldGroup key={kind} title={t(kind === 'monitor' ? 'monitorAlerts' : 'syncAlerts')}><NotificationPolicyControl enabled={notifications[kind].notificationEnabled} ids={notifications[kind].notificationChannelIds} disabled={busy} onValidityChange={kind === 'monitor' ? setMonitorValid : setSyncValid} onChange={(notificationEnabled, notificationChannelIds) => setNotifications(previous => ({ ...previous, [kind]: { ...previous[kind], notificationEnabled, notificationChannelIds } }))} context={{ sourceType: 'subscription', groupId: kind === 'monitor' && category === 'website' ? groupId || null : null, eventKind: kind === 'sync' ? 'subscription_sync' : category === 'model' ? 'ai_state' : 'monitor_state' }} /></FieldGroup>)}
        {notifications.sync.notificationEnabled ? <Input type="number" min={60} max={86400} label={t('syncDelay')} value={String(notifications.sync.afterSec)} onValueChange={value => setNotifications(previous => ({ ...previous, sync: { ...previous.sync, afterSec: Number(value) } }))} /> : null}
        <p className="text-small text-default-500">{t('createSummary', { count: selected.size, category: t(category), seconds: intervalSec })}</p>
        {modelDisabled ? <p role="alert" className="text-small text-warning">{t('enableAI')} <Link to="/admin/settings" className="underline">{t('settings')}</Link></p> : null}
        <div className="flex gap-3"><Button variant="flat" isDisabled={busy} onPress={() => setStep(2)}>{t('previous')}</Button><Button color="primary" isLoading={busy} isDisabled={!name.trim() || modelDisabled || !monitorValid || !syncValid} onPress={() => void create()}>{t('create')}</Button></div>
      </> : null}
    </div>
  </AdminPage>;
}
