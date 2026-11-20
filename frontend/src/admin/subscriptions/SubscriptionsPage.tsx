import { stateTone, toneCounts, ToneMix } from '@/components/subscriptions/observation';
import { SubscriptionGlyph } from '@/components/subscriptions/SubscriptionGlyph';
import { Dropdown, Select } from '@/components/ui/MotionOverlays';
import { useTimeAgo } from '@/hooks/useTimeAgo';
import { Button, Checkbox, DropdownItem, DropdownMenu, DropdownSection, DropdownTrigger, Input, SelectItem, Switch, Tooltip } from '@heroui/react';
import clsx from 'clsx';
import { Archive, ArchiveRestore, CircleAlert, CircleCheck, CircleDashed, Download, FileCode2, Layers, Link2, MoreHorizontal, Pause, Play, Plus, RefreshCw, Rss, Search, TriangleAlert, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import useSWR from 'swr';
import { useFormatter, useTranslations } from 'use-intl';
import type { Subscription } from '../../../../shared/subscriptions';
import { EmptyState } from '../components/ConsolePrimitives';
import { SearchArt } from '../components/illustrations';
import { StatBand, StatCell } from '../components/SummaryStats';
import { AdminPage } from '../layout/AdminPage';
import { subscriptionsApi } from './api';
import { MonitorSources } from './MonitorSources';
import { CategorySwitch, Failure, Loading, Pagination, Status, subscriptionHealth, SubscriptionTabs, Tag, useDuration } from './Parts';
import { SubscriptionConfigEditor } from './SubscriptionConfigEditor';
import { SubscriptionCreate } from './SubscriptionCreate';
import { SubscriptionDetail } from './SubscriptionDetail';
import { SubscriptionLibrary } from './SubscriptionLibrary';

export function SubscriptionsPage() {
  const { id, templateId } = useParams();
  const pathname = window.location.pathname;
  if (pathname.endsWith('/new')) return <SubscriptionCreate />;
  if (pathname.includes('/library')) return <SubscriptionLibrary templateId={templateId} />;
  if (id && pathname.endsWith('/config')) return <SubscriptionConfigEditor id={id} />;
  if (id) return <SubscriptionDetail key={id} id={id} />;
  return <SubscriptionList />;
}

const REFRESH_MS = 30000;
const HEALTH = ['all', 'healthy', 'partial', 'failed', 'paused'] as const;
type RowOp = 'pause' | 'resume' | 'archive' | 'restore';

/*
  One template for the header and every row. Below lg a row stacks: name and
  actions, then sync state and item counts.
  表头与各行共用一套列模板；小于 lg 时依次为名称与操作、同步状态与条目统计。
*/
const GRID = 'grid grid-cols-[1.25rem_minmax(0,1fr)_auto] gap-x-3 gap-y-2 lg:grid-cols-[1.25rem_minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1.1fr)_7rem_4.75rem] lg:items-center lg:gap-x-5';

function SubscriptionList() {
  const t = useTranslations('admin.subscriptions');
  const [search, setSearch] = useSearchParams();
  const query = search.toString();
  const category = search.get('category') || 'all';
  const health = search.get('health') || 'all';
  const archived = search.get('archived') === 'true';
  const resource = useSWR(['console:subscriptions', query], () => subscriptionsApi.list(query), { refreshInterval: REFRESH_MS, shouldRetryOnError: false });
  const [selected, setSelected] = useState(new Set<string>());
  const [error, setError] = useState<unknown>();
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<{ id: string; name: string; error?: unknown }[]>([]);
  const lock = useRef(false);
  useEffect(() => { setSelected(new Set()); }, [query]);

  const rows = resource.data?.items ?? [];
  const filtered = Boolean(search.get('q')) || health !== 'all';
  const updateQuery = (key: string, value: string) => {
    const next = new URLSearchParams(search);
    if (!value || value === 'all' || (key === 'archived' && value === 'false')) next.delete(key);
    else next.set(key, value);
    next.delete('offset');
    setSelected(new Set());
    setSearch(next, { replace: true });
  };
  const reload = async () => { await resource.mutate(); };

  const run = async (key: string, work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(key); setError(undefined);
    try { await work(); } catch (cause) { setError(cause); } finally { lock.current = false; setBusy(null); }
  };
  const patchFor = (op: RowOp) => op === 'archive' ? { archived: true } : op === 'restore' ? { archived: false, enabled: false } : { enabled: op === 'resume', archived: false };
  const batch = (op: 'pause' | 'resume' | 'archive') => run('bulk', async () => {
    setResults([]);
    const outcomes: { id: string; name: string; error?: unknown }[] = [];
    for (const row of rows) if (selected.has(row.id)) {
      try { await subscriptionsApi.update(row, patchFor(op)); outcomes.push({ id: row.id, name: row.name }); }
      catch (cause) { outcomes.push({ id: row.id, name: row.name, error: cause }); }
      setResults([...outcomes]);
    }
    setSelected(new Set(outcomes.filter(outcome => outcome.error).map(outcome => outcome.id)));
    await reload();
  });
  const act = (row: Subscription, op: RowOp) => run(`row:${row.id}`, async () => { await subscriptionsApi.update(row, patchFor(op)); await reload(); });
  const sync = (row: Subscription) => run(`row:${row.id}`, async () => { const { run: result } = await subscriptionsApi.sync(row.id); if (result.error) setError(result.error); await reload(); });

  const counts = resource.data?.summary;
  const allShown = rows.length > 0 && rows.every(row => selected.has(row.id));
  const someShown = rows.some(row => selected.has(row.id));
  const selectAll = (
    <Checkbox size="sm" aria-label={t('selectAll')} className="mr-1 pl-2" isSelected={allShown} isIndeterminate={someShown && !allShown} isDisabled={!rows.length || busy !== null} onValueChange={on => setSelected(on ? new Set(rows.map(row => row.id)) : new Set())} />
  );
  const failedCount = results.filter(result => result.error).length;

  return (
    <AdminPage
      title={t('title')}
      description={t('description')}
      actions={
        <>
          <Button as={Link} to="/admin/subscriptions/new?source=link" variant="bordered" startContent={<Link2 size={15} />}>{t('importLink')}</Button>
          <Button as={Link} to="/admin/subscriptions/new" color="primary" startContent={<Plus size={16} />}>{t('add')}</Button>
        </>
      }
    >
      <SubscriptionTabs counts={counts ? { mine: counts.total } : undefined} />
      {category === 'website' || category === 'model' ? <MonitorSources category={category} active="subscription" /> : null}

      {counts && counts.total > 0 ? (
        <StatBand className="mb-5 grid-cols-2 sm:grid-cols-3 lg:grid-cols-5">
          <StatCell label={t('statTotal')} icon={<Layers />} value={counts.total} sub={t('statItems', { count: counts.items })} active={health === 'all'} onPress={health === 'all' ? undefined : () => updateQuery('health', 'all')} />
          <StatCell label={t('status.healthy')} icon={<CircleCheck />} value={counts.healthy} active={health === 'healthy'} onPress={() => updateQuery('health', health === 'healthy' ? 'all' : 'healthy')} />
          <StatCell label={t('status.partial')} icon={<TriangleAlert />} value={counts.partial} tone={counts.partial ? 'warn' : undefined} active={health === 'partial'} onPress={() => updateQuery('health', health === 'partial' ? 'all' : 'partial')} />
          <StatCell label={t('status.failed')} icon={<CircleAlert />} value={counts.failed} tone={counts.failed ? 'down' : undefined} active={health === 'failed'} onPress={() => updateQuery('health', health === 'failed' ? 'all' : 'failed')} />
          <StatCell label={t('status.paused')} icon={<CircleDashed />} value={counts.paused} active={health === 'paused'} onPress={() => updateQuery('health', health === 'paused' ? 'all' : 'paused')} />
        </StatBand>
      ) : null}

      <Failure error={error || resource.error} retry={() => void reload()} />

      {results.length && busy !== 'bulk' ? (
        <div role="status" className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-well)] px-4 py-2.5 text-[12.5px] text-[var(--polaris-ink-2)]">
          <span className="polaris-num font-medium">{t('bulkResult', { success: results.length - failedCount, failed: failedCount })}</span>
          {results.filter(result => result.error).map(result => <span key={result.id} className="text-danger-600">{result.name}</span>)}
          <button type="button" aria-label={t('cancel')} onClick={() => setResults([])} className="ml-auto text-[var(--polaris-ink-4)] hover:text-[var(--polaris-ink)]"><X size={14} /></button>
        </div>
      ) : null}

      <section className={clsx('polaris-card flex min-h-[18rem] flex-1 flex-col overflow-hidden', busy === 'bulk' && 'polaris-sweep')}>
        <div className="flex flex-wrap items-center gap-2 border-b border-[var(--polaris-line)] px-3 py-2.5">
          {selected.size ? (
            <>
              {selectAll}
              <span className="polaris-num mr-1 text-[13px] font-semibold text-[var(--polaris-ink)]">{busy === 'bulk' ? t('bulkProgress', { done: results.length, total: selected.size }) : t('selectedCount', { count: selected.size })}</span>
              <div className="flex flex-wrap items-center gap-1">
                <Button size="sm" variant="light" isDisabled={busy !== null} startContent={<Play size={14} />} onPress={() => void batch('resume')}>{t('resume')}</Button>
                <Button size="sm" variant="light" isDisabled={busy !== null} startContent={<Pause size={14} />} onPress={() => void batch('pause')}>{t('pause')}</Button>
                <Button size="sm" variant="light" isDisabled={busy !== null} startContent={<Archive size={14} />} onPress={() => void batch('archive')}>{t('archive')}</Button>
              </div>
              <Button size="sm" variant="light" className="ml-auto" isDisabled={busy !== null} startContent={<X size={14} />} onPress={() => setSelected(new Set())}>{t('clearSelection')}</Button>
            </>
          ) : (
            <>
              {rows.length ? selectAll : null}
              <CategorySwitch all value={category} onChange={value => updateQuery('category', value)} />
              <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <Switch size="sm" isSelected={archived} onValueChange={value => updateQuery('archived', String(value))} classNames={{ label: 'text-[12.5px] text-[var(--polaris-ink-2)]' }}>{t('showArchived')}</Switch>
                <Select size="sm" className="w-full sm:w-36" aria-label={t('syncHealth')} selectedKeys={[health]} disallowEmptySelection onChange={event => updateQuery('health', event.target.value)}>
                  {HEALTH.map(key => <SelectItem key={key}>{key === 'all' ? t('allHealth') : t(`status.${key}`)}</SelectItem>)}
                </Select>
                <Input
                  size="sm"
                  className="w-full sm:w-60"
                  aria-label={t('search')}
                  placeholder={t('search')}
                  value={search.get('q') || ''}
                  onValueChange={value => updateQuery('q', value)}
                  startContent={<Search className="shrink-0 text-[var(--polaris-ink-4)]" size={14} />}
                  endContent={search.get('q') ? <button type="button" aria-label={t('cancel')} onClick={() => updateQuery('q', '')} className="text-[var(--polaris-ink-4)] hover:text-[var(--polaris-ink)]"><X size={14} /></button> : null}
                />
              </div>
            </>
          )}
        </div>

        <div className="min-h-0 flex-1">
          {!resource.data && !resource.error ? (
            <div className="p-3"><Loading /></div>
          ) : rows.length === 0 ? (
            filtered ? (
              <EmptyState art={<SearchArt />} title={t('noResults')} action={<Button size="sm" variant="bordered" onPress={() => setSearch({})}>{t('clearFilters')}</Button>} />
            ) : (
              <EmptyState
                art={<span className="flex h-14 w-14 items-center justify-center rounded-2xl border border-[var(--polaris-line)] bg-[var(--polaris-well)] text-[var(--polaris-ink-3)]"><Rss size={24} /></span>}
                title={t('empty')}
                hint={t('emptyHint')}
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    <Button as={Link} to="/admin/subscriptions/library" color="primary" size="sm">{t('browse')}</Button>
                    <Button as={Link} to="/admin/subscriptions/new?source=json" variant="bordered" size="sm" startContent={<FileCode2 size={14} />}>{t('json')}</Button>
                  </div>
                }
              />
            )
          ) : (
            <>
              <div aria-hidden="true" className={clsx(GRID, 'hidden border-b border-[var(--polaris-line-soft)] px-5 py-2 text-[12px] text-[var(--polaris-ink-3)] lg:grid')}>
                <span />
                <span>{t('colName')}</span>
                <span>{t('colSync')}</span>
                <span>{t('colItems')}</span>
                <span>{t('colSchedule')}</span>
                <span className="text-right">{t('colActions')}</span>
              </div>
              <ul className="divide-y divide-[var(--polaris-line-soft)]">
                {rows.map(row => (
                  <SubscriptionRow
                    key={row.id}
                    row={row}
                    selected={selected.has(row.id)}
                    locked={busy !== null}
                    rowBusy={busy === `row:${row.id}`}
                    onSelect={on => setSelected(previous => { const next = new Set(previous); if (on) next.add(row.id); else next.delete(row.id); return next; })}
                    onSync={() => void sync(row)}
                    onAction={op => void act(row, op)}
                  />
                ))}
              </ul>
            </>
          )}
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-t border-[var(--polaris-line)] px-4 py-2 text-[12px] text-[var(--polaris-ink-3)]">
          <span className="flex items-center gap-1.5">
            <span className="polaris-live h-1.5 w-1.5 rounded-full bg-success" />
            {t('autoRefresh', { seconds: REFRESH_MS / 1000 })}
          </span>
          {resource.data ? <div className="min-w-0 flex-1"><Pagination total={resource.data.total} nextOffset={resource.data.nextOffset} /></div> : null}
        </div>
      </section>
    </AdminPage>
  );
}

function SubscriptionRow({ row, selected, locked, rowBusy, onSelect, onSync, onAction }: {
  row: Subscription;
  selected: boolean;
  locked: boolean;
  rowBusy: boolean;
  onSelect: (on: boolean) => void;
  onSync: () => void;
  onAction: (op: RowOp) => void;
}) {
  const t = useTranslations('admin.subscriptions');
  const format = useFormatter();
  const ago = useTimeAgo();
  const duration = useDuration();
  const navigate = useNavigate();
  const health = subscriptionHealth(row);
  const tone = stateTone(health);
  const { runtime } = row;
  const discovered = Math.max(0, runtime.itemCount - runtime.selectedCount);
  const syncing = runtime.phase !== 'idle';
  const isArchived = row.archivedAt !== null;
  const now = Math.floor(Date.now() / 1000);
  const href = `/admin/subscriptions/${row.id}`;

  return (
    <li className={clsx('px-4 py-3.5 transition-colors sm:px-5', selected ? 'bg-[var(--polaris-hover)]' : 'hover:bg-[var(--polaris-hover)]', isArchived && 'opacity-75')}>
      <div className={GRID}>
        <div className="col-start-1 row-start-1 flex items-center">
          <Checkbox size="sm" aria-label={t('selectItem', { name: row.name })} isSelected={selected} isDisabled={locked} onValueChange={onSelect} />
        </div>

        <div className="col-start-2 row-start-1 flex min-w-0 items-center gap-3">
          <SubscriptionGlyph id={row.id} category={row.category} badge={tone} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-1.5">
              <Link to={href} className="min-w-0 truncate text-[14px] font-medium text-[var(--polaris-ink)] underline-offset-4 hover:underline">{row.name}</Link>
              {row.isPublic ? null : <Tag className="hidden sm:inline-flex">{t('private')}</Tag>}
              {row.configUpdate?.changed ? (
                <Link to={`${href}/config`} className="shrink-0">
                  <Tag tone={row.configUpdate.conflict ? 'warning' : 'primary'} title={t(row.configUpdate.conflict ? 'versionConflict' : 'updateAvailable', { version: row.configUpdate.version || row.templateVersion })}>
                    <Download size={11} />{row.configUpdate.version || t('update')}
                  </Tag>
                </Link>
              ) : null}
            </div>
            <p className="mt-0.5 flex min-w-0 items-center gap-1.5 text-[12px] text-[var(--polaris-ink-3)]">
              <span className="shrink-0">{row.templateName}</span>
              <span className="polaris-num shrink-0 text-[var(--polaris-ink-4)]">{row.templateVersion}</span>
              {row.sourceHosts?.length ? <span className="min-w-0 truncate font-mono text-[11.5px] text-[var(--polaris-ink-4)]" title={row.sourceHosts.join(', ')}>· {row.sourceHosts.join(', ')}</span> : null}
            </p>
          </div>
        </div>

        <div className="col-span-2 col-start-2 row-start-2 min-w-0 lg:col-span-1 lg:col-start-3 lg:row-start-1">
          <p className="flex min-w-0 items-center gap-1.5">
            {syncing ? <Status value={runtime.phase === 'queued' ? 'deferred' : runtime.phase} /> : <Status value={health} />}
            {!syncing && runtime.failures > 1 && health !== 'healthy' ? <span className="polaris-num shrink-0 rounded-full bg-danger/[0.08] px-1.5 text-[12px] font-medium text-danger-600">{t('failStreak', { count: runtime.failures })}</span> : null}
          </p>
          <p className="mt-0.5 truncate text-[12px] text-[var(--polaris-ink-3)]">
            {runtime.lastSuccessAt ? (
              <span title={format.dateTime(new Date(runtime.lastSuccessAt * 1000), { dateStyle: 'medium', timeStyle: 'medium' })}>{t('lastSuccessAgo', { time: ago(runtime.lastSuccessAt) })}</span>
            ) : t('neverSynced')}
          </p>
        </div>

        <div className="col-span-2 col-start-2 row-start-3 min-w-0 lg:col-span-1 lg:col-start-4 lg:row-start-1">
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px]">
            <span className="polaris-num font-medium text-[var(--polaris-ink)]">{t('subscribedItems', { count: runtime.selectedCount })}</span>
            {discovered ? <Tag tone="primary">{t('newItems', { count: discovered })}</Tag> : null}
          </p>
          <ToneMix counts={toneCounts(row.statusCounts)} className="mt-1.5 w-full max-w-[14rem]" />
        </div>

        <div className="hidden min-w-0 text-[12px] text-[var(--polaris-ink-3)] lg:col-start-5 lg:row-start-1 lg:block">
          <span className="block text-[12.5px] text-[var(--polaris-ink-2)]">{t('every', { duration: duration(row.intervalSec) })}</span>
          {row.enabled && !isArchived && runtime.nextDueAt > now ? (
            <span className="block truncate text-[var(--polaris-ink-4)]">{t('nextSync', { time: format.relativeTime(new Date(runtime.nextDueAt * 1000), new Date(now * 1000)) })}</span>
          ) : null}
        </div>

        <div className="col-start-3 row-start-1 flex items-center justify-end gap-0.5 lg:col-start-6">
          <Tooltip content={t('sync')} delay={300} closeDelay={0}>
            <Button size="sm" isIconOnly variant="light" aria-label={t('sync')} isDisabled={locked || !row.enabled || isArchived} isLoading={rowBusy} onPress={onSync}>
              <RefreshCw size={15} />
            </Button>
          </Tooltip>
          <Dropdown placement="bottom-end">
            <DropdownTrigger>
              <Button size="sm" isIconOnly variant="light" isDisabled={locked} aria-label={t('moreNamed', { name: row.name })}>
                <MoreHorizontal size={16} />
              </Button>
            </DropdownTrigger>
            <DropdownMenu aria-label={t('moreNamed', { name: row.name })}>
              <DropdownSection showDivider>
                <DropdownItem key="open" startContent={<Layers size={15} />} onPress={() => navigate(href)}>{t('items')}</DropdownItem>
                <DropdownItem key="config" startContent={<FileCode2 size={15} />} onPress={() => navigate(`${href}/config`)}>{t('config')}</DropdownItem>
              </DropdownSection>
              {isArchived ? (
                <DropdownSection>
                  <DropdownItem key="restore" startContent={<ArchiveRestore size={15} />} onPress={() => onAction('restore')}>{t('restore')}</DropdownItem>
                </DropdownSection>
              ) : (
                <DropdownSection>
                  <DropdownItem key="toggle" startContent={row.enabled ? <Pause size={15} /> : <Play size={15} />} onPress={() => onAction(row.enabled ? 'pause' : 'resume')}>{t(row.enabled ? 'pause' : 'resume')}</DropdownItem>
                  <DropdownItem key="archive" startContent={<Archive size={15} />} onPress={() => onAction('archive')}>{t('archive')}</DropdownItem>
                </DropdownSection>
              )}
            </DropdownMenu>
          </Dropdown>
        </div>
      </div>
    </li>
  );
}
