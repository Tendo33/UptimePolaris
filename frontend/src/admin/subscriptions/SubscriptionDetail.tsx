import { Drawer, Modal, Select } from '@/components/ui/MotionOverlays';
import { Button, Checkbox, DrawerBody, DrawerContent, DrawerHeader, Input, ModalBody, ModalContent, ModalFooter, ModalHeader, SelectItem, Switch } from '@heroui/react';
import { RefreshCw } from 'lucide-react';
import { useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import useSWR from 'swr';
import { useFormatter, useTranslations } from 'use-intl';
import type { Subscription, SubscriptionItem } from '../../../../shared/subscriptions';
import { AdminPage } from '../layout/AdminPage';
import { EmptyState } from '../components/ConsolePrimitives';
import { NotificationPolicyControl } from '../notifications/NotificationPolicyControl';
import { groupsApi } from '../groups/api';
import { subscriptionsApi, useSubscription } from './api';
import { DetailTabs, Failure, FieldGroup, Loading, Pagination, Status, subscriptionHealth, Timestamp, useDraftWarning, useSubscriptionError } from './Parts';

export function SubscriptionDetail({ id }: { id: string }) {
  const describe = useSubscriptionError(), t = useTranslations('admin.subscriptions'), [search, setSearch] = useSearchParams();
  const resource = useSubscription(id), subscription = resource.data?.subscription;
  const tab = search.get('tab') || 'items';
  const [activeRunId, setActiveRunId] = useState<string>();
  const activeRun = useSWR(activeRunId ? ['console:subscription-run', activeRunId] : null, () => subscriptionsApi.run(activeRunId!), { refreshInterval: data => data?.run.state === 'running' ? 1000 : 0, shouldRetryOnError: false });
  const itemQuery = new URLSearchParams(search); if (!itemQuery.has('state')) itemQuery.set('state', 'selected');
  const items = useSWR(subscription && tab === 'items' ? ['console:subscription-items', id, itemQuery.toString()] : null, () => subscriptionsApi.items(id, itemQuery.toString()), { refreshInterval: 30000, shouldRetryOnError: false });
  const runs = useSWR(subscription && tab === 'runs' ? ['console:subscription-runs', id] : null, () => subscriptionsApi.runs(id), { refreshInterval: 10000, shouldRetryOnError: false });
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [editing, setEditing] = useState<SubscriptionItem>();
  const [selected, setSelected] = useState(new Set<string>()), [outcomes, setOutcomes] = useState<{ id: string; ok: boolean; error?: string }[]>([]);
  const lock = useRef(false);
  const reload = async () => { await Promise.all([resource.mutate(), items.mutate(), runs.mutate()]); };
  const action = async (work: () => Promise<void>) => { if (lock.current) return; lock.current = true; setBusy(true); setError(undefined); try { await work(); await reload(); } catch (error) { setError(error); } finally { lock.current = false; setBusy(false); } };
  const change = (key: string, value: string) => { const next = new URLSearchParams(search); next.set(key, value); next.delete('offset'); setSelected(new Set()); setSearch(next, { replace: true }); };
  const bulk = (patch: Partial<SubscriptionItem>) => action(async () => { const result = await subscriptionsApi.updateItems(id, (items.data?.items ?? []).filter(item => selected.has(item.id)).map(item => ({ id: item.id, revision: item.revision, ...patch }))); setOutcomes(result.results); setSelected(new Set()); });
  return <AdminPage title={subscription?.name || t('title')} back={{ href: '/admin/subscriptions', label: t('mine') }} actions={subscription ? <Button color="primary" variant="flat" isLoading={busy} isDisabled={!subscription.enabled || subscription.archivedAt !== null} startContent={<RefreshCw size={14} />} onPress={() => void action(async () => { const { run } = await subscriptionsApi.sync(id, run => setActiveRunId(run.id)); if (run.error) setError(run.error); })}>{t('sync')}</Button> : undefined}>
    <Failure error={error || resource.error} retry={() => void resource.mutate()} />
    {!subscription && !resource.error ? <Loading /> : subscription ? <>
      <div className="mb-6 flex flex-wrap items-center gap-4 text-small text-default-500"><Status value={subscriptionHealth(subscription)} /><span>{t('lastSuccess')}: <Timestamp value={subscription.runtime.lastSuccessAt} /></span><span>{subscription.templateName} {subscription.templateVersion}</span></div>
      {activeRun.data?.run.state === 'running' ? <p role="status" className="mb-4 flex flex-wrap gap-3 text-small"><Status value={activeRun.data.run.phase} />{t('runCounts', { requests: activeRun.data.run.requests, items: activeRun.data.run.updatedItems })}</p> : null}<DetailTabs id={id} active={tab} />
      {tab === 'items' ? <>
        <div className="mb-4 flex flex-wrap items-center gap-3"><Select size="sm" className="w-44" aria-label={t('itemScope')} selectedKeys={[search.get('state') || 'selected']} onChange={event => change('state', event.target.value)}>{['selected', 'discovered', 'removed', 'all'].map(key => <SelectItem key={key}>{t(key)}</SelectItem>)}</Select><Input size="sm" className="min-w-48 flex-1" aria-label={t('search')} placeholder={t('search')} value={search.get('q') || ''} onValueChange={value => change('q', value)} /></div>
        <Failure error={items.error} retry={() => void items.mutate()} />
        {selected.size ? <div className="mb-4 flex flex-wrap items-center gap-2"><span className="text-small">{t('selectedCount', { count: selected.size })}</span>{([{ label: 'subscribe', patch: { selected: true } }, { label: 'unsubscribe', patch: { selected: false } }, { label: 'publish', patch: { isPublic: true } }, { label: 'hide', patch: { isPublic: false } }, { label: 'mute', patch: { muted: true } }, { label: 'unmute', patch: { muted: false } }] as const).map(operation => <Button key={operation.label} size="sm" variant="flat" isDisabled={busy} onPress={() => void bulk(operation.patch)}>{t(operation.label)}</Button>)}</div> : null}
        {outcomes.length ? <div role="status" className="mb-3 text-small">{t('bulkResult', { success: outcomes.filter(result => result.ok).length, failed: outcomes.filter(result => !result.ok).length })}{outcomes.filter(result => !result.ok).map(result => <Failure key={result.id} error={`${result.id}: ${result.error}`} />)}</div> : null}
        {!items.data && !items.error ? <Loading /> : items.data?.items.length === 0 ? <EmptyState title={t('noItems')} /> : <div className="polaris-card divide-y divide-divider">{items.data?.items.map(item => <div key={item.id} className="flex flex-wrap items-center gap-4 p-4"><Checkbox aria-label={t('selectItem', { name: item.localName || item.name })} isSelected={selected.has(item.id)} onValueChange={value => setSelected(previous => { const next = new Set(previous); value ? next.add(item.id) : next.delete(item.id); return next; })} /><button className="min-w-40 flex-1 text-left" onClick={() => setEditing(item)}><span className="block text-small font-semibold hover:text-primary">{item.localName || item.name}</span><span className="mt-1 block text-small text-default-500">{item.group || item.modelId || item.sourceItemId}</span></button><Status value={item.freshness === 'current' ? item.displayStatus : item.freshness} /><span className="text-small text-default-500">{t(item.isPublic && subscription.isPublic ? 'public' : 'private')}{item.muted ? ` · ${t('muted')}` : ''}</span><span className="text-small text-default-500"><Timestamp value={item.mode === 'heartbeat' ? item.observation?.observedAt : item.observation?.fetchedAt} /></span></div>)}</div>}
        {items.data ? <Pagination total={items.data.total} nextOffset={items.data.nextOffset} /> : null}
      </> : tab === 'runs' ? <>
        <Failure error={runs.error} retry={() => void runs.mutate()} />
        {!runs.data && !runs.error ? <Loading /> : !runs.data?.runs.length ? <EmptyState title={t('noRuns')} /> : <div className="polaris-card divide-y divide-divider">{[...runs.data.runs].sort((a, b) => b.startedAt - a.startedAt).map(run => <div key={run.id} className="flex flex-wrap items-center gap-4 p-4 text-small"><Status value={run.state === 'running' ? run.phase : run.state} /><Timestamp value={run.startedAt} /><span className="text-default-500">{t('runCounts', { requests: run.requests, items: run.updatedItems })}</span>{run.error ? <span className="text-danger">{describe(run.error)}</span> : null}</div>)}</div>}
      </> : <SubscriptionSettings key={subscription.revision} subscription={subscription} onSaved={reload} />}
      {editing ? <ItemDrawer key={editing.id} item={editing} onClose={() => setEditing(undefined)} onSaved={async () => { setEditing(undefined); await reload(); }} /> : null}
    </> : null}
  </AdminPage>;
}

function ItemDrawer({ item, onClose, onSaved }: { item: SubscriptionItem; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useTranslations('admin.subscriptions'), format = useFormatter();
  const groups = useSWR('console:subscription-groups', groupsApi.listGroups, { shouldRetryOnError: false });
  const [name, setName] = useState(item.localName || ''), [groupId, setGroupId] = useState(item.groupId || ''), [order, setOrder] = useState(item.sortOrder);
  const [isPublic, setPublic] = useState(item.isPublic), [muted, setMuted] = useState(item.muted), [selected, setSelected] = useState(item.selected);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const save = async () => { setBusy(true); setError(undefined); try { const result = await subscriptionsApi.updateItems(item.subscriptionId, [{ id: item.id, revision: item.revision, localName: name || null, groupId: groupId || null, sortOrder: order, isPublic, muted, selected }]); if (!result.results[0]?.ok) { setError(result.results[0]?.error); return; } await onSaved(); } catch (error) { setError(error); } finally { setBusy(false); } };
  return <Drawer isOpen onClose={onClose} size="lg" scrollBehavior="inside"><DrawerContent><DrawerHeader>{item.localName || item.name}</DrawerHeader><DrawerBody className="gap-5 pb-8">
    <Status value={item.freshness === 'current' ? item.displayStatus : item.freshness} /><Failure error={error} />
    <Input label={t('localName')} placeholder={item.name} value={name} onValueChange={setName} maxLength={120} />
    {item.category === 'website' ? <Select label={t('group')} selectedKeys={groupId ? [groupId] : []} isDisabled={!groups.data} onChange={event => setGroupId(event.target.value)}>{(groups.data?.groups ?? []).map(group => <SelectItem key={group.id}>{group.name}</SelectItem>)}</Select> : null}
    <Input type="number" label={t('sortOrder')} min={0} max={100000} value={String(order)} onValueChange={value => setOrder(Number(value))} />
    <Switch isSelected={selected} onValueChange={setSelected}>{t('subscribe')}</Switch><Switch isSelected={isPublic} onValueChange={setPublic}>{t('publish')}</Switch><Switch isSelected={muted} onValueChange={setMuted}>{t('mute')}</Switch>
    <Button color="primary" isLoading={busy} onPress={() => void save()}>{t('save')}</Button>
    <FieldGroup title={t('history')}><p className="text-small text-default-500">{t(item.mode === 'heartbeat' ? 'heartbeatHistory' : 'snapshotHistory')}</p>{item.availability ? <p className="text-small">{t('sourceAvailability', { hours: item.availability.windowSec / 3600, value: format.number(item.availability.value, { maximumFractionDigits: 2 }) })}</p> : null}<ul className="divide-y divide-divider">{[...item.recent].reverse().map((point, index) => <li key={index} className="flex flex-wrap items-center gap-3 py-2 text-small"><Status value={point.status} /><Timestamp value={point.observedAt ?? point.fetchedAt} />{point.latencyMs !== null ? <span className="tabular-nums">{format.number(point.latencyMs)} ms</span> : null}{point.reason ? <span className="w-full break-words text-default-500">{point.reason}</span> : null}</li>)}</ul></FieldGroup>
  </DrawerBody></DrawerContent></Drawer>;
}

function SubscriptionSettings({ subscription, onSaved }: { subscription: Subscription; onSaved: () => Promise<void> }) {
  const t = useTranslations('admin.subscriptions'), navigate = useNavigate();
  const [draft, setDraft] = useState(subscription), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [confirm, setConfirm] = useState(false);
  const [monitorValid, setMonitorValid] = useState(true), [syncValid, setSyncValid] = useState(true);
  const allowNavigation = useDraftWarning(JSON.stringify(draft) !== JSON.stringify(subscription));
  const save = async () => { setBusy(true); setError(undefined); try { await subscriptionsApi.update(subscription, { name: draft.name, enabled: draft.enabled, isPublic: draft.isPublic, autoSubscribe: draft.autoSubscribe, intervalSec: draft.intervalSec, staleAfterSec: draft.staleAfterSec, notifications: draft.notifications, archived: draft.archivedAt !== null }); await onSaved(); } catch (error) { setError(error); } finally { setBusy(false); } };
  const remove = async () => { setBusy(true); try { await subscriptionsApi.remove(subscription); allowNavigation(); navigate('/admin/subscriptions'); } catch (error) { setError(error); setConfirm(false); } finally { setBusy(false); } };
  return <div className="max-w-3xl space-y-6 pb-8"><Failure error={error} /><Input label={t('name')} value={draft.name} onValueChange={name => setDraft({ ...draft, name })} />
    <div className="grid gap-4 sm:grid-cols-2"><Input label={t('interval')} type="number" min={60} max={86400} value={String(draft.intervalSec)} onValueChange={value => setDraft({ ...draft, intervalSec: Number(value) })} /><Input label={t('staleAfter')} type="number" min={60} max={604800} value={String(draft.staleAfterSec)} onValueChange={value => setDraft({ ...draft, staleAfterSec: Number(value) })} /></div>
    <div className="flex flex-col gap-4"><Switch isSelected={draft.enabled} onValueChange={enabled => setDraft({ ...draft, enabled })} isDisabled={draft.archivedAt !== null}>{t('enabled')}</Switch><Switch isSelected={draft.isPublic} onValueChange={isPublic => setDraft({ ...draft, isPublic })}>{t('public')}</Switch><Switch isSelected={draft.autoSubscribe} onValueChange={autoSubscribe => setDraft({ ...draft, autoSubscribe })}>{t('autoSubscribe')}</Switch></div>
    {(['monitor', 'sync'] as const).map(kind => <FieldGroup key={kind} title={t(kind === 'monitor' ? 'monitorAlerts' : 'syncAlerts')}><NotificationPolicyControl enabled={draft.notifications[kind].notificationEnabled} ids={draft.notifications[kind].notificationChannelIds} disabled={busy} onValidityChange={kind === 'monitor' ? setMonitorValid : setSyncValid} onChange={(notificationEnabled, notificationChannelIds) => setDraft(previous => ({ ...previous, notifications: { ...previous.notifications, [kind]: { ...previous.notifications[kind], notificationEnabled, notificationChannelIds } } }))} context={{ subscriptionId: subscription.id, sourceType: 'subscription', eventKind: kind === 'sync' ? 'subscription_sync' : subscription.category === 'model' ? 'ai_state' : 'monitor_state' }} /></FieldGroup>)}
    {draft.notifications.sync.notificationEnabled ? <Input type="number" label={t('syncDelay')} min={60} max={86400} value={String(draft.notifications.sync.afterSec)} onValueChange={value => setDraft({ ...draft, notifications: { ...draft.notifications, sync: { ...draft.notifications.sync, afterSec: Number(value) } } })} /> : null}
    <div className="flex flex-wrap gap-3"><Button color="primary" isLoading={busy} isDisabled={!monitorValid || !syncValid} onPress={() => void save()}>{t('save')}</Button><Button variant="flat" isDisabled={busy} onPress={() => setDraft({ ...draft, archivedAt: draft.archivedAt === null ? Date.now() / 1000 : null, enabled: false })}>{t(draft.archivedAt === null ? 'archive' : 'restore')}</Button></div>
    {subscription.archivedAt !== null ? <section className="space-y-3 border-t border-divider pt-6"><h2 className="font-semibold">{t('delete')}</h2><p className="text-small text-default-500">{t('deleteHint')}</p><Button color="danger" variant="flat" onPress={() => setConfirm(true)}>{t('delete')}</Button></section> : null}
    <Modal isOpen={confirm} onClose={() => setConfirm(false)}><ModalContent><ModalHeader>{t('delete')}</ModalHeader><ModalBody>{t('deleteConfirm', { name: subscription.name })}</ModalBody><ModalFooter><Button variant="flat" onPress={() => setConfirm(false)}>{t('cancel')}</Button><Button color="danger" isLoading={busy} onPress={() => void remove()}>{t('delete')}</Button></ModalFooter></ModalContent></Modal>
  </div>;
}
