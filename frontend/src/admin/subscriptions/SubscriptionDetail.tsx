import { ObservationRail, stateTone, toneCounts } from '@/components/subscriptions/observation';
import { GlyphTile } from '@/components/ui/GlyphTile';
import { Drawer, Dropdown, Modal, Select } from '@/components/ui/MotionOverlays';
import { Segmented } from '@/components/ui/Segmented';
import { StatusDot, TONE_TEXT } from '@/components/ui/StatusDot';
import { useTimeAgo } from '@/hooks/useTimeAgo';
import { Button, Checkbox, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader, DropdownItem, DropdownMenu, DropdownSection, DropdownTrigger, Input, ModalBody, ModalContent, ModalFooter, ModalHeader, SelectItem, Spinner, Switch, Tooltip } from '@heroui/react';
import clsx from 'clsx';
import { Archive, ArchiveRestore, ArrowUpRight, Bell, BellOff, Bot, CircleCheck, Clock, Download, Eye, EyeOff, Globe, History, Layers, LockKeyhole, MoreHorizontal, Pause, Pencil, Play, Plus, RefreshCw, Search, Settings2, Trash2, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import useSWR from 'swr';
import { useFormatter, useTranslations } from 'use-intl';
import type { Subscription, SubscriptionItem } from '../../../../shared/subscriptions';
import { EmptyState } from '../components/ConsolePrimitives';
import { SearchArt } from '../components/illustrations';
import { StatBand, StatCell } from '../components/SummaryStats';
import { groupsApi } from '../groups/api';
import { AdminPage } from '../layout/AdminPage';
import { NotificationPolicyControl } from '../notifications/NotificationPolicyControl';
import { subscriptionsApi, useSubscription, type Run } from './api';
import { SubscriptionConfigEditor } from './SubscriptionConfigEditor';
import { DetailTabs, Failure, FieldGroup, IntervalPresets, Loading, Note, Pagination, SettingRow, Status, subscriptionHealth, Tag, Timestamp, useDraftWarning, useDuration, useSubscriptionError } from './Parts';

const SCOPES = ['selected', 'discovered', 'removed', 'all'] as const;

export function SubscriptionDetail({ id }: { id: string }) {
  const describe = useSubscriptionError(), t = useTranslations('admin.subscriptions'), [search, setSearch] = useSearchParams();
  const format = useFormatter();
  const ago = useTimeAgo();
  const duration = useDuration();
  const resource = useSubscription(id), subscription = resource.data?.subscription;
  const requestedTab = search.get('tab');
  const tab = requestedTab && ['items', 'runs', 'config', 'settings'].includes(requestedTab) ? requestedTab : 'items';
  const [activeRunId, setActiveRunId] = useState<string>();
  const activeRun = useSWR(activeRunId ? ['console:subscription-run', activeRunId] : null, () => subscriptionsApi.run(activeRunId!), { refreshInterval: data => data?.run.state === 'running' ? 1000 : 0, shouldRetryOnError: false });
  const itemQuery = new URLSearchParams(search); itemQuery.delete('tab'); if (!itemQuery.has('state')) itemQuery.set('state', 'selected');
  const items = useSWR(subscription && tab === 'items' ? ['console:subscription-items', id, itemQuery.toString()] : null, () => subscriptionsApi.items(id, itemQuery.toString()), { refreshInterval: 30000, shouldRetryOnError: false });
  const runs = useSWR(subscription && tab === 'runs' ? ['console:subscription-runs', id] : null, () => subscriptionsApi.runs(id), { refreshInterval: 10000, shouldRetryOnError: false });
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [editing, setEditing] = useState<SubscriptionItem>();
  const [selected, setSelected] = useState(new Set<string>()), [outcomes, setOutcomes] = useState<{ id: string; ok: boolean; error?: string }[]>([]);
  const lock = useRef(false);
  const reload = async () => { await Promise.all([resource.mutate(), items.mutate(), runs.mutate()]); };
  const action = async (work: () => Promise<void>) => { if (lock.current) return; lock.current = true; setBusy(true); setError(undefined); try { await work(); await reload(); } catch (cause) { setError(cause); } finally { lock.current = false; setBusy(false); } };
  const change = (key: string, value: string) => { const next = new URLSearchParams(search); if (value) next.set(key, value); else next.delete(key); next.delete('offset'); setSelected(new Set()); setSearch(next, { replace: true }); };
  const bulk = (patch: Partial<SubscriptionItem>) => action(async () => { const result = await subscriptionsApi.updateItems(id, (items.data?.items ?? []).filter(item => selected.has(item.id)).map(item => ({ id: item.id, revision: item.revision, ...patch }))); setOutcomes(result.results); setSelected(new Set(result.results.filter(outcome => !outcome.ok).map(outcome => outcome.id))); });
  const sync = () => action(async () => { const { run } = await subscriptionsApi.sync(id, progress => setActiveRunId(progress.id)); if (run.error) setError(run.error); });
  const setState = (patch: { enabled?: boolean; archived?: boolean }) => subscription && action(async () => { await subscriptionsApi.update(subscription, patch); });

  const health = subscription ? subscriptionHealth(subscription) : 'unknown';
  const healthTone = stateTone(health);
  const archived = subscription?.archivedAt != null;
  const running = activeRun.data?.run.state === 'running' ? activeRun.data.run : null;
  const rows = items.data?.items ?? [];
  useEffect(() => { setSelected(new Set()); }, [id, itemQuery.toString()]);
  const allShown = rows.length > 0 && rows.every(item => selected.has(item.id));
  const someShown = rows.some(item => selected.has(item.id));
  const now = Math.floor(Date.now() / 1000);
  const itemTones = toneCounts(subscription?.statusCounts);
  const up = itemTones.up ?? 0;
  const tracked = Object.values(itemTones).reduce((sum, n) => sum + (n ?? 0), 0);

  return (
    <AdminPage
      title={subscription?.name || t('title')}
      description={subscription ? `${t(subscription.category)} · ${subscription.templateName} ${subscription.templateVersion}` : undefined}
      back={{ href: '/admin/subscriptions', label: t('mine') }}
      actions={subscription ? (
        <>
          {subscription.sourcePageUrl ? <Button as="a" href={subscription.sourcePageUrl} target="_blank" rel="noreferrer" variant="light" endContent={<ArrowUpRight size={14} />}>{t('sourcePage')}</Button> : null}
          <Dropdown placement="bottom-end">
            <DropdownTrigger>
              <Button variant="bordered" isIconOnly aria-label={t('moreNamed', { name: subscription.name })} isDisabled={busy}><MoreHorizontal size={16} /></Button>
            </DropdownTrigger>
            <DropdownMenu aria-label={t('moreNamed', { name: subscription.name })}>
              <DropdownSection showDivider>
                <DropdownItem key="export" startContent={<Download size={15} />} href={`/api/admin/subscriptions/${encodeURIComponent(id)}/config/export`}>{t('export')}</DropdownItem>
              </DropdownSection>
              {archived ? (
                <DropdownSection>
                  <DropdownItem key="restore" startContent={<ArchiveRestore size={15} />} onPress={() => void setState({ archived: false, enabled: false })}>{t('restore')}</DropdownItem>
                </DropdownSection>
              ) : (
                <DropdownSection>
                  <DropdownItem key="toggle" startContent={subscription.enabled ? <Pause size={15} /> : <Play size={15} />} onPress={() => void setState(subscription.enabled ? { enabled: false } : { enabled: true, archived: false })}>{t(subscription.enabled ? 'pause' : 'resume')}</DropdownItem>
                  <DropdownItem key="archive" startContent={<Archive size={15} />} onPress={() => void setState({ archived: true })}>{t('archive')}</DropdownItem>
                </DropdownSection>
              )}
            </DropdownMenu>
          </Dropdown>
          <Button color="primary" isLoading={busy && !!running} isDisabled={busy || !subscription.enabled || archived} startContent={busy && running ? undefined : <RefreshCw size={15} />} onPress={() => void sync()}>{t('sync')}</Button>
        </>
      ) : undefined}
    >
      <Failure error={error || resource.error} retry={() => void resource.mutate()} />
      {!subscription && !resource.error ? <Loading /> : subscription ? (
        <>
          <StatBand className="mb-4 grid-cols-2 lg:grid-cols-4">
            <StatCell label={t('syncHealth')} icon={<CircleCheck />} value={t(`status.${health}`)} tone={healthTone === 'down' || healthTone === 'warn' || healthTone === 'pending' ? healthTone : undefined} sub={subscription.runtime.lastSuccessAt ? t('lastSuccessAgo', { time: ago(subscription.runtime.lastSuccessAt) }) : t('neverSynced')} />
            <StatCell label={t('selected')} icon={<Layers />} value={subscription.runtime.selectedCount} sub={t('discoveredTotal', { count: subscription.runtime.itemCount })} />
            <StatCell label={t('itemHealth')} icon={<Eye />} value={tracked ? `${up}/${tracked}` : '—'} sub={t('itemHealthSub')} />
            <StatCell label={t('intervalShort')} icon={<Clock />} value={duration(subscription.intervalSec)} sub={subscription.enabled && !archived && subscription.runtime.nextDueAt > now ? t('nextSync', { time: format.relativeTime(new Date(subscription.runtime.nextDueAt * 1000), new Date(now * 1000)) }) : t(`status.${health}`)} />
          </StatBand>

          {subscription.runtime.error && health !== 'healthy' && !running ? (
            <Note tone="warn" className="mb-4">
              <p className="font-medium">{describe(subscription.runtime.error)}</p>
              <p className="mt-0.5 text-[12px] opacity-80">
                {subscription.runtime.failureSince ? t('failingSince', { time: ago(subscription.runtime.failureSince) }) : null}
                {subscription.runtime.failures > 1 ? ` · ${t('failStreak', { count: subscription.runtime.failures })}` : ''}
              </p>
            </Note>
          ) : null}

          {running ? (
            <div role="status" className="polaris-card polaris-sweep mb-4 flex flex-wrap items-center gap-3 px-4 py-3 text-[13px]">
              <Spinner size="sm" color="default" />
              <Status value={running.phase} />
              <span className="polaris-num text-[var(--polaris-ink-3)]">{t('runCounts', { requests: running.requests, items: running.updatedItems })}</span>
            </div>
          ) : null}

          <DetailTabs id={id} active={tab} counts={{ items: tab === 'items' ? items.data?.total : undefined, runs: runs.data?.runs.length }} />

          {tab === 'items' ? (
            <>
              <Failure error={items.error} retry={() => void items.mutate()} />
              {outcomes.length ? (
                <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-well)] px-4 py-2.5 text-[12.5px] text-[var(--polaris-ink-2)]">
                  <span className="polaris-num font-medium">{t('bulkResult', { success: outcomes.filter(result => result.ok).length, failed: outcomes.filter(result => !result.ok).length })}</span>
                  {outcomes.filter(result => !result.ok).map(result => <span key={result.id} className="text-danger-600">{describe(result.error)}</span>)}
                  <button type="button" aria-label={t('cancel')} onClick={() => setOutcomes([])} className="ml-auto text-[var(--polaris-ink-4)] hover:text-[var(--polaris-ink)]"><X size={14} /></button>
                </div>
              ) : null}

              <section className={clsx('polaris-card flex min-h-[16rem] flex-1 flex-col overflow-hidden', busy && 'polaris-sweep')}>
                <div className="flex flex-wrap items-center gap-2 border-b border-[var(--polaris-line)] px-3 py-2.5">
                  {rows.length ? <Checkbox size="sm" aria-label={t('selectAll')} className="mr-1 pl-2" isSelected={allShown} isIndeterminate={someShown && !allShown} isDisabled={busy} onValueChange={on => setSelected(on ? new Set(rows.map(item => item.id)) : new Set())} /> : null}
                  {selected.size ? (
                    <>
                      <span className="polaris-num mr-1 text-[13px] font-semibold text-[var(--polaris-ink)]">{t('selectedCount', { count: selected.size })}</span>
                      <div className="flex flex-wrap items-center gap-1">
                        {([
                          { label: 'subscribe', icon: <Plus size={14} />, patch: { selected: true } },
                          { label: 'unsubscribe', icon: <X size={14} />, patch: { selected: false } },
                          { label: 'publish', icon: <Eye size={14} />, patch: { isPublic: true } },
                          { label: 'hide', icon: <EyeOff size={14} />, patch: { isPublic: false } },
                          { label: 'mute', icon: <BellOff size={14} />, patch: { muted: true } },
                          { label: 'unmute', icon: <Bell size={14} />, patch: { muted: false } },
                        ] as const).map(operation => <Button key={operation.label} size="sm" variant="light" isDisabled={busy} startContent={operation.icon} onPress={() => void bulk(operation.patch)}>{t(operation.label)}</Button>)}
                      </div>
                      <Button size="sm" variant="light" className="ml-auto" isDisabled={busy} startContent={<X size={14} />} onPress={() => setSelected(new Set())}>{t('clearSelection')}</Button>
                    </>
                  ) : (
                    <>
                      <Segmented label={t('itemScope')} value={search.get('state') || 'selected'} onChange={value => change('state', value === 'selected' ? '' : value)} options={SCOPES.map(key => ({ value: key, label: t(key) }))} />
                      <Input
                        size="sm"
                        className="w-full sm:ml-auto sm:w-60"
                        aria-label={t('searchItems')}
                        placeholder={t('searchItems')}
                        value={search.get('q') || ''}
                        onValueChange={value => change('q', value)}
                        startContent={<Search className="shrink-0 text-[var(--polaris-ink-4)]" size={14} />}
                        endContent={search.get('q') ? <button type="button" aria-label={t('cancel')} onClick={() => change('q', '')} className="text-[var(--polaris-ink-4)] hover:text-[var(--polaris-ink)]"><X size={14} /></button> : null}
                      />
                    </>
                  )}
                </div>

                <div className="min-h-0 flex-1">
                  {!items.data && !items.error ? (
                    <div className="p-3"><Loading /></div>
                  ) : rows.length === 0 ? (
                    <EmptyState art={<SearchArt />} title={t('noItems')} hint={search.get('state') === 'discovered' ? undefined : t('noItemsHint')} action={search.get('q') ? <Button size="sm" variant="bordered" onPress={() => change('q', '')}>{t('clearFilters')}</Button> : undefined} />
                  ) : (
                    <>
                      <div className="polaris-scroll-x overflow-x-auto">
                      <table className="polaris-table min-w-[34rem] table-fixed text-[13px]">
                        <thead><tr><th className="w-10 px-3" /><th className="pl-4">{t('colName')}</th><th className="w-28 text-right sm:w-[15%]">{t('colReading')}</th><th className="hidden w-[15%] text-right sm:table-cell">{t('sourceAvailabilityColumn')}</th><th className="hidden w-[30%] xl:table-cell">{t('colRecent')}</th><th className="w-14 pr-4"><span className="sr-only">{t('colActions')}</span></th></tr></thead>
                        <tbody>
                        {rows.map(item => (
                          <ItemRow
                            key={item.id}
                            item={item}
                            subscription={subscription}
                            selected={selected.has(item.id)}
                            locked={busy}
                            onSelect={on => setSelected(previous => { const next = new Set(previous); if (on) next.add(item.id); else next.delete(item.id); return next; })}
                            onOpen={() => setEditing(item)}
                          />
                        ))}
                        </tbody>
                      </table>
                      </div>
                    </>
                  )}
                </div>
                {items.data ? <div className="border-t border-[var(--polaris-line)] px-4 py-2"><Pagination total={items.data.total} nextOffset={items.data.nextOffset} /></div> : null}
              </section>
            </>
          ) : tab === 'runs' ? (
            <>
              <Failure error={runs.error} retry={() => void runs.mutate()} />
              {!runs.data && !runs.error ? <Loading /> : !runs.data?.runs.length ? (
                <div className="polaris-card"><EmptyState art={<span className="flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--polaris-line)] bg-[var(--polaris-well)] text-[var(--polaris-ink-3)]"><History size={20} /></span>} title={t('noRuns')} /></div>
              ) : (
                <ol className="polaris-card divide-y divide-[var(--polaris-line-soft)] overflow-hidden">
                  {[...runs.data.runs].sort((a, b) => b.startedAt - a.startedAt).map(run => <RunRow key={run.id} run={run} />)}
                </ol>
              )}
            </>
          ) : tab === 'config' ? <SubscriptionConfigEditor id={id} onSaved={reload} /> : <SubscriptionSettings key={subscription.id} subscription={subscription} onSaved={reload} />}

          {editing ? <ItemDrawer key={editing.id} item={editing} onClose={() => setEditing(undefined)} onSaved={async () => { setEditing(undefined); await reload(); }} /> : null}
        </>
      ) : null}
    </AdminPage>
  );
}

function ItemRow({ item, subscription, selected, locked, onSelect, onOpen }: { item: SubscriptionItem; subscription: Subscription; selected: boolean; locked: boolean; onSelect: (on: boolean) => void; onOpen: () => void }) {
  const t = useTranslations('admin.subscriptions');
  const ago = useTimeAgo();
  const format = useFormatter();
  const state = item.freshness === 'current' ? item.displayStatus : item.freshness;
  const tone = stateTone(state);
  const at = item.mode === 'heartbeat' ? item.observation?.observedAt : item.observation?.fetchedAt;
  const name = item.localName || item.name;
  const Icon = item.category === 'model' ? Bot : Globe;
  const shownPublic = item.isPublic && subscription.isPublic;
  return (
    <tr className={clsx('group cursor-pointer', (!item.selected || item.removedAt) && 'opacity-70')} onClick={event => { if (!(event.target as HTMLElement).closest('button, a, input, label, [role="checkbox"]')) onOpen(); }}>
      <td className="px-3"><Checkbox size="sm" aria-label={t('selectItem', { name })} isSelected={selected} isDisabled={locked} onValueChange={onSelect} /></td>
      <td className="min-w-0 pl-4">
        <div className="flex min-w-0 items-center gap-3">
          <GlyphTile badge={tone}><Icon size={17} /></GlyphTile>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <button type="button" onClick={onOpen} className="min-w-0 max-w-full truncate text-left text-[13.5px] font-medium text-[var(--polaris-ink)] hover:underline" title={name}>{name}</button>
              {!shownPublic ? <span title={t(item.isPublic ? 'publicBlocked' : 'private')} aria-label={t('private')} role="img" className="text-[var(--polaris-ink-3)]"><LockKeyhole size={13} /></span> : null}
              {item.muted ? <span title={t('muted')}><BellOff size={13} /></span> : null}
              {!item.selected ? <Tag>{t(item.removedAt ? 'removed' : 'discovered')}</Tag> : null}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--polaris-ink-3)]">
              <span className={clsx('shrink-0 font-medium', tone === 'idle' ? 'text-[var(--polaris-ink-3)]' : TONE_TEXT[tone])}>{t(`status.${state}`)}</span><span aria-hidden="true">·</span><span className="min-w-0 flex-1 truncate" title={item.modelId || item.url || item.group || item.sourceItemId}>{item.modelId || item.url || item.group || item.sourceItemId}</span>
            </div>
          </div>
        </div>
      </td>
      <td className="text-right whitespace-nowrap"><span className="polaris-num text-[13px] font-medium">{item.freshness === 'current' && tone !== 'down' && item.observation?.latencyMs != null ? `${Math.round(item.observation.latencyMs)} ms` : '—'}</span><span className="block text-[12px] text-[var(--polaris-ink-3)]">{at ? ago(at) : t('never')}</span></td>
      <td className="hidden text-right whitespace-nowrap sm:table-cell"><span className="polaris-num text-[13px]" title={item.availability ? t('sourceAvailability', { hours: item.availability.windowSec / 3600, value: item.availability.value }) : undefined}>{item.availability ? `${format.number(item.availability.value, { maximumFractionDigits: 2 })}%` : '—'}</span></td>
      <td className="hidden xl:table-cell"><ObservationRail points={item.recent} max={40} height="h-5" /></td>
      <td className="pr-4 text-right"><Button size="sm" isIconOnly variant="light" aria-label={t('editItem')} onPress={onOpen}><Pencil size={14} /></Button></td>
    </tr>
  );
}

function RunRow({ run }: { run: Run }) {
  const t = useTranslations('admin.subscriptions');
  const statusText = useTranslations('admin.subscriptions.status');
  const describe = useSubscriptionError();
  const format = useFormatter();
  const ago = useTimeAgo();
  const state = run.state === 'running' ? run.phase : run.state;
  const tone = stateTone(state);
  const seconds = run.finishedAt ? Math.max(0, run.finishedAt - run.startedAt) : null;
  return (
    <li className="px-5 py-3.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 leading-5">
        <span className={clsx('inline-flex items-center gap-3 text-[13px] font-medium leading-5', tone === 'idle' ? 'text-[var(--polaris-ink-2)]' : TONE_TEXT[tone])}>
          <StatusDot tone={tone} size={8} pulse={tone === 'pending'} />
          {statusText.has(state) ? statusText(state) : state}
        </span>
        <span className="text-[12.5px] leading-5 text-[var(--polaris-ink-2)]" title={format.dateTime(new Date(run.startedAt * 1000), { dateStyle: 'medium', timeStyle: 'medium' })}>{ago(run.startedAt)}</span>
        {seconds !== null ? <span className="polaris-num text-[12px] leading-5 text-[var(--polaris-ink-4)]">{t('runDuration', { seconds: format.number(seconds, { maximumFractionDigits: 1 }) })}</span> : null}
        <span className="polaris-num ml-auto text-[12px] leading-5 text-[var(--polaris-ink-3)]">{t('runCounts', { requests: run.requests, items: run.updatedItems })}</span>
      </div>
      {run.error ? <p className="mt-1 break-words pl-5 text-[12.5px] leading-5 text-danger-600">{describe(run.error)}</p> : null}
    </li>
  );
}

function ItemDrawer({ item, onClose, onSaved }: { item: SubscriptionItem; onClose: () => void; onSaved: () => Promise<void> }) {
  const t = useTranslations('admin.subscriptions'), format = useFormatter();
  const groups = useSWR('console:subscription-groups', groupsApi.listGroups, { shouldRetryOnError: false });
  const [name, setName] = useState(item.localName || ''), [groupId, setGroupId] = useState(item.groupId || ''), [order, setOrder] = useState(item.sortOrder);
  const [isPublic, setPublic] = useState(item.isPublic), [muted, setMuted] = useState(item.muted), [selected, setSelected] = useState(item.selected);
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const save = async () => { setBusy(true); setError(undefined); try { const result = await subscriptionsApi.updateItems(item.subscriptionId, [{ id: item.id, revision: item.revision, localName: name || null, groupId: groupId || null, sortOrder: order, isPublic, muted, selected }]); if (!result.results[0]?.ok) { setError(result.results[0]?.error); return; } await onSaved(); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  const state = item.freshness === 'current' ? item.displayStatus : item.freshness;
  const Icon = item.category === 'model' ? Bot : Globe;
  const facts = [
    { label: t('sourceId'), value: item.sourceItemId, mono: true },
    item.group ? { label: t('sourceGroup'), value: item.group } : null,
    item.modelId ? { label: t('modelId'), value: item.modelId, mono: true } : null,
    item.provider ? { label: t('provider'), value: item.provider } : null,
    { label: t('mode'), value: t(item.mode === 'heartbeat' ? 'modeHeartbeat' : 'modeSnapshot') },
    item.availability ? { label: t('sourceAvailabilityShort', { hours: item.availability.windowSec / 3600 }), value: `${format.number(item.availability.value, { maximumFractionDigits: 2 })}%` } : null,
  ].filter((fact): fact is { label: string; value: string; mono?: boolean } => fact !== null);

  return (
    <Drawer isOpen onClose={onClose} size="lg" scrollBehavior="inside">
      <DrawerContent>
        <DrawerHeader className="flex items-center gap-3 border-b border-[var(--polaris-line-soft)]">
          <GlyphTile badge={stateTone(state)}><Icon size={17} /></GlyphTile>
          <div className="min-w-0 flex-1">
            <p className="truncate text-[14px] font-semibold text-[var(--polaris-ink)]">{item.localName || item.name}</p>
            <Status value={state} className="text-[12px]" />
          </div>
        </DrawerHeader>
        <DrawerBody className="gap-5 py-5">
          <Failure error={error} className="" />
          <section>
            <ObservationRail points={item.recent} max={40} height="h-7" />
            <p className="mt-2 text-[12px] text-[var(--polaris-ink-4)]">{t(item.mode === 'heartbeat' ? 'heartbeatHistory' : 'snapshotHistory')}</p>
          </section>

          <dl className="overflow-hidden rounded-xl border border-[var(--polaris-line)] divide-y divide-[var(--polaris-line-soft)]">
            {facts.map(fact => (
              <div key={fact.label} className="flex items-baseline gap-4 px-4 py-2.5">
                <dt className="shrink-0 text-[12.5px] text-[var(--polaris-ink-3)]">{fact.label}</dt>
                <dd className={clsx('ml-auto min-w-0 truncate text-right text-[13px] text-[var(--polaris-ink)]', fact.mono && 'font-mono text-[12px]')} title={fact.value}>{fact.value}</dd>
              </div>
            ))}
            {item.url ? (
              <div className="flex items-baseline gap-4 px-4 py-2.5">
                <dt className="shrink-0 text-[12.5px] text-[var(--polaris-ink-3)]">URL</dt>
                <dd className="ml-auto min-w-0 truncate text-right"><a href={item.url} target="_blank" rel="noreferrer" className="font-mono text-[12px] text-[var(--polaris-ink)] underline underline-offset-4">{item.url}</a></dd>
              </div>
            ) : null}
          </dl>

          <section className="space-y-4">
            <h3 className="text-[13px] font-semibold text-[var(--polaris-ink)]">{t('display')}</h3>
            <Input label={t('localName')} labelPlacement="outside" placeholder={item.name} value={name} onValueChange={setName} maxLength={120} />
            <div className="grid gap-4 sm:grid-cols-2">
              {item.category === 'website' ? (
                <Select label={t('group')} labelPlacement="outside" placeholder={t('noGroup')} selectedKeys={groupId ? [groupId] : []} isDisabled={!groups.data} onChange={event => setGroupId(event.target.value)}>
                  {(groups.data?.groups ?? []).map(group => <SelectItem key={group.id}>{group.name}</SelectItem>)}
                </Select>
              ) : null}
              <Input type="number" labelPlacement="outside" label={t('sortOrder')} min={0} max={100000} value={String(order)} onValueChange={value => setOrder(Number(value))} />
            </div>
            <SettingRow title={t('subscribe')} hint={t('subscribeHint')}><Switch size="sm" aria-label={t('subscribe')} isSelected={selected} onValueChange={setSelected} /></SettingRow>
            <SettingRow title={t('publish')} hint={t('publishHint')}><Switch size="sm" aria-label={t('publish')} isSelected={isPublic} onValueChange={setPublic} /></SettingRow>
            <SettingRow title={t('mute')} hint={t('muteHint')}><Switch size="sm" aria-label={t('mute')} isSelected={muted} onValueChange={setMuted} /></SettingRow>
          </section>

          <section>
            <h3 className="mb-2 text-[13px] font-semibold text-[var(--polaris-ink)]">{t('history')}</h3>
            {item.recent.length ? (
              <ol className="space-y-px">
                {[...item.recent].reverse().map((point, index) => {
                  const at = point.observedAt ?? point.fetchedAt;
                  return (
                    <li key={index} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 rounded-lg px-2 py-1.5 text-[12.5px] hover:bg-[var(--polaris-hover)]">
                      <Status value={point.status} className="text-[12.5px]" />
                      <span className="min-w-0 truncate text-[var(--polaris-ink-4)]" title={point.reason ?? undefined}>{point.reason}</span>
                      <span className="polaris-num flex items-center gap-3 text-[var(--polaris-ink-3)]">
                        {point.latencyMs !== null ? <span>{format.number(point.latencyMs)} ms</span> : null}
                        <Timestamp value={at} />
                      </span>
                    </li>
                  );
                })}
              </ol>
            ) : <p className="text-[12.5px] text-[var(--polaris-ink-3)]">{t('never')}</p>}
          </section>
        </DrawerBody>
        <DrawerFooter className="border-t border-[var(--polaris-line-soft)]">
          <Button variant="light" onPress={onClose}>{t('cancel')}</Button>
          <Button color="primary" isLoading={busy} onPress={() => void save()}>{t('save')}</Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}

function SubscriptionSettings({ subscription, onSaved }: { subscription: Subscription; onSaved: () => Promise<void> }) {
  const t = useTranslations('admin.subscriptions'), navigate = useNavigate();
  const [draft, setDraft] = useState(subscription), [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [confirm, setConfirm] = useState(false);
  const [base, setBase] = useState(subscription);
  const observedRevision = useRef(subscription.revision);
  const [monitorValid, setMonitorValid] = useState(true), [syncValid, setSyncValid] = useState(true);
  const editable = (value: Subscription) => JSON.stringify([value.name, value.enabled, value.isPublic, value.autoSubscribe, value.intervalSec, value.staleAfterSec, value.notifications, value.archivedAt]);
  const dirty = editable(draft) !== editable(base);
  useEffect(() => {
    if (observedRevision.current === subscription.revision) return;
    observedRevision.current = subscription.revision;
    if (!dirty && !busy) { setBase(subscription); setDraft(subscription); }
  }, [subscription, dirty, busy]);
  const allowNavigation = useDraftWarning(dirty);
  const save = async () => { setBusy(true); setError(undefined); try { const result = await subscriptionsApi.update(base, { name: draft.name, enabled: draft.enabled, isPublic: draft.isPublic, autoSubscribe: draft.autoSubscribe, intervalSec: draft.intervalSec, staleAfterSec: draft.staleAfterSec, notifications: draft.notifications, archived: draft.archivedAt !== null }); setBase(result.subscription); setDraft(result.subscription); await onSaved(); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  const remove = async () => { setBusy(true); try { await subscriptionsApi.remove(subscription); allowNavigation(); navigate('/admin/subscriptions'); } catch (cause) { setError(cause); setConfirm(false); } finally { setBusy(false); } };

  return (
    <fieldset disabled={busy} className="grid min-w-0 items-start gap-5 pb-8 xl:grid-cols-2">
      <Failure error={error} className="xl:col-span-2" />

      <FieldGroup title={t('basics')} icon={<Settings2 />} className="xl:col-span-2">
        <Input label={t('name')} labelPlacement="outside" value={draft.name} onValueChange={name => setDraft({ ...draft, name })} />
        <div className="grid gap-5 sm:grid-cols-2">
          <div className="space-y-2">
            <Input label={t('interval')} labelPlacement="outside" type="number" min={60} max={86400} value={String(draft.intervalSec)} onValueChange={value => setDraft({ ...draft, intervalSec: Number(value) })} />
            <IntervalPresets value={draft.intervalSec} onChange={intervalSec => setDraft({ ...draft, intervalSec })} options={[60, 300, 900, 3600]} />
          </div>
          <div className="space-y-2">
            <Input label={t('staleAfter')} labelPlacement="outside" type="number" min={60} max={604800} value={String(draft.staleAfterSec)} onValueChange={value => setDraft({ ...draft, staleAfterSec: Number(value) })} />
            <IntervalPresets value={draft.staleAfterSec} onChange={staleAfterSec => setDraft({ ...draft, staleAfterSec })} options={[300, 900, 3600, 86400]} />
          </div>
        </div>
        <SettingRow title={t('enabled')} hint={draft.archivedAt !== null ? t('archivedHint') : undefined}><Switch size="sm" aria-label={t('enabled')} isSelected={draft.enabled} onValueChange={enabled => setDraft({ ...draft, enabled })} isDisabled={draft.archivedAt !== null} /></SettingRow>
        <SettingRow title={t('public')} hint={t('publicHint')}><Switch size="sm" aria-label={t('public')} isSelected={draft.isPublic} onValueChange={isPublic => setDraft({ ...draft, isPublic })} /></SettingRow>
        <SettingRow title={t('autoSubscribe')} hint={t('autoSubscribeHint')}><Switch size="sm" aria-label={t('autoSubscribe')} isSelected={draft.autoSubscribe} onValueChange={autoSubscribe => setDraft({ ...draft, autoSubscribe })} /></SettingRow>
      </FieldGroup>

      {(['monitor', 'sync'] as const).map(kind => (
        <FieldGroup key={kind} title={t(kind === 'monitor' ? 'monitorAlerts' : 'syncAlerts')} icon={<Bell />} description={t(kind === 'monitor' ? 'monitorAlertsHint' : 'syncAlertsHint')}>
          <NotificationPolicyControl enabled={draft.notifications[kind].notificationEnabled} ids={draft.notifications[kind].notificationChannelIds} disabled={busy} onValidityChange={kind === 'monitor' ? setMonitorValid : setSyncValid} onChange={(notificationEnabled, notificationChannelIds) => setDraft(previous => ({ ...previous, notifications: { ...previous.notifications, [kind]: { ...previous.notifications[kind], notificationEnabled, notificationChannelIds } } }))} context={{ subscriptionId: subscription.id, sourceType: 'subscription', eventKind: kind === 'sync' ? 'subscription_sync' : subscription.category === 'model' ? 'ai_state' : 'monitor_state' }} />
          {kind === 'sync' && draft.notifications.sync.notificationEnabled ? (
            <Input type="number" labelPlacement="outside" className="max-w-xs" label={t('syncDelay')} min={60} max={86400} value={String(draft.notifications.sync.afterSec)} onValueChange={value => setDraft({ ...draft, notifications: { ...draft.notifications, sync: { ...draft.notifications.sync, afterSec: Number(value) } } })} />
          ) : null}
        </FieldGroup>
      ))}

      <div className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom,0px))] z-20 flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--polaris-line)] bg-[var(--polaris-card)] px-4 py-3 shadow-[0_10px_30px_-16px_rgb(0_0_0/0.35)] lg:bottom-3 xl:col-span-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--polaris-ink-3)]">{dirty ? t('unsaved') : t('noChanges')}</span>
        {dirty ? <Button variant="light" isDisabled={busy} onPress={() => { setBase(subscription); setDraft(subscription); }}>{t('discard')}</Button> : null}
        <Button variant="bordered" isDisabled={busy} startContent={draft.archivedAt === null ? <Archive size={14} /> : <ArchiveRestore size={14} />} onPress={() => setDraft({ ...draft, archivedAt: draft.archivedAt === null ? Date.now() / 1000 : null, enabled: false })}>{t(draft.archivedAt === null ? 'archive' : 'restore')}</Button>
        <Button color="primary" isLoading={busy} isDisabled={!dirty || !monitorValid || !syncValid} onPress={() => void save()}>{t('save')}</Button>
      </div>

      {subscription.archivedAt !== null ? (
        <section className="rounded-2xl border border-danger/25 p-5 xl:col-span-2">
          <h2 className="text-[14px] font-semibold text-danger-600">{t('delete')}</h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-[var(--polaris-ink-3)]">{t('deleteHint')}</p>
          <Button className="mt-4" color="danger" variant="flat" startContent={<Trash2 size={14} />} onPress={() => setConfirm(true)}>{t('delete')}</Button>
        </section>
      ) : (
        <p className="px-1 text-[12px] text-[var(--polaris-ink-4)]">{t('deleteAfterArchive')}</p>
      )}

      <Modal isOpen={confirm} onClose={() => setConfirm(false)}>
        <ModalContent>
          <ModalHeader>{t('delete')}</ModalHeader>
          <ModalBody className="text-[13px] text-[var(--polaris-ink-2)]">{t('deleteConfirm', { name: subscription.name })}</ModalBody>
          <ModalFooter>
            <Button variant="flat" onPress={() => setConfirm(false)}>{t('cancel')}</Button>
            <Button color="danger" isLoading={busy} onPress={() => void remove()}>{t('delete')}</Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </fieldset>
  );
}
