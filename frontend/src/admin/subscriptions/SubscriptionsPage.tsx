import { Button, Checkbox, Input, SelectItem } from '@heroui/react';
import { Select } from '@/components/ui/MotionOverlays';
import { Plus, RefreshCw, Rss } from 'lucide-react';
import { useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import useSWR from 'swr';
import { useTranslations } from 'use-intl';
import { EmptyState } from '../components/ConsolePrimitives';
import { AdminPage } from '../layout/AdminPage';
import { subscriptionsApi } from './api';
import { CategorySwitch, Failure, Loading, Pagination, Status, subscriptionHealth, SubscriptionTabs, Timestamp } from './Parts';
import { MonitorSources } from './MonitorSources';
import { SubscriptionLibrary } from './SubscriptionLibrary';
import { SubscriptionCreate } from './SubscriptionCreate';
import { SubscriptionDetail } from './SubscriptionDetail';
import { SubscriptionConfigEditor } from './SubscriptionConfigEditor';

export function SubscriptionsPage() {
  const { id, templateId } = useParams();
  const pathname = window.location.pathname;
  if (pathname.endsWith('/new')) return <SubscriptionCreate />;
  if (pathname.includes('/library')) return <SubscriptionLibrary templateId={templateId} />;
  if (id && pathname.endsWith('/config')) return <SubscriptionConfigEditor id={id} />;
  if (id) return <SubscriptionDetail key={id} id={id} />;
  return <SubscriptionList />;
}
function SubscriptionList() {
  const t = useTranslations('admin.subscriptions'), [search, setSearch] = useSearchParams();
  const query = search.toString();
  const resource = useSWR(['console:subscriptions', query], () => subscriptionsApi.list(query), { refreshInterval: 30000, shouldRetryOnError: false });
  const [selected, setSelected] = useState(new Set<string>()), [error, setError] = useState<unknown>(), [busy, setBusy] = useState(false);
  const [results, setResults] = useState<{ name: string; error?: unknown }[]>([]);
  const lock = useRef(false);
  const updateQuery = (key: string, value: string) => { const next = new URLSearchParams(search); next.set(key, value); next.delete('offset'); setSearch(next, { replace: true }); };
  const batch = async (operation: 'pause' | 'resume' | 'archive') => {
    if (lock.current) return; lock.current = true; setBusy(true); setError(undefined); setResults([]);
    const outcomes: { name: string; error?: unknown }[] = [];
    for (const row of resource.data?.items ?? []) if (selected.has(row.id)) {
      try { await subscriptionsApi.update(row, operation === 'archive' ? { archived: true } : { enabled: operation === 'resume', archived: false }); outcomes.push({ name: row.name }); }
      catch (error) { outcomes.push({ name: row.name, error }); }
      setResults([...outcomes]);
    }
    setSelected(new Set()); await resource.mutate().catch(setError); lock.current = false; setBusy(false);
  };
  const sync = async (id: string) => { if (lock.current) return; lock.current = true; setBusy(true); setError(undefined); try { const { run } = await subscriptionsApi.sync(id); if (run.error) setError(run.error); await resource.mutate(); } catch (error) { setError(error); } finally { lock.current = false; setBusy(false); } };
  return <AdminPage title={t('title')} description={t('description')} actions={<><Button as={Link} to="/admin/subscriptions/new?source=link" variant="flat">{t('importLink')}</Button><Button as={Link} to="/admin/subscriptions/new" color="primary" startContent={<Plus size={16} />}>{t('add')}</Button></>}>
    <SubscriptionTabs />{search.get('category') === 'website' || search.get('category') === 'model' ? <MonitorSources category={search.get('category') as 'website' | 'model'} active="subscription" /> : null}
    <div className="mb-5 flex flex-wrap items-center gap-3">
      <CategorySwitch all value={search.get('category') || 'all'} onChange={value => { const next = new URLSearchParams(search); value === 'all' ? next.delete('category') : next.set('category', value); next.delete('offset'); setSearch(next); }} />
      <Input className="min-w-48 flex-1" size="sm" aria-label={t('search')} placeholder={t('search')} value={search.get('q') || ''} onValueChange={value => updateQuery('q', value)} />
      <Select className="w-40" size="sm" aria-label={t('syncHealth')} selectedKeys={[search.get('health') || 'all']} onChange={event => updateQuery('health', event.target.value)}>{['all', 'healthy', 'partial', 'failed', 'paused'].map(key => <SelectItem key={key}>{key === 'all' ? t('all') : t(`status.${key}`)}</SelectItem>)}</Select>
      <Checkbox size="sm" isSelected={search.get('archived') === 'true'} onValueChange={value => updateQuery('archived', String(value))}>{t('showArchived')}</Checkbox>
    </div>
    <Failure error={error || resource.error} retry={() => void resource.mutate()} />
    {selected.size ? <div className="my-3 flex flex-wrap items-center gap-2 text-small"><span>{t('selectedCount', { count: selected.size })}</span>{(['pause', 'resume', 'archive'] as const).map(operation => <Button key={operation} size="sm" variant="flat" isDisabled={busy} onPress={() => void batch(operation)}>{t(operation)}</Button>)}</div> : null}
    {results.length ? <ul aria-live="polite" className="my-3 space-y-2 text-small">{results.map(result => <li key={result.name}>{result.name} · {result.error ? <Failure error={result.error} /> : t('saved')}</li>)}</ul> : null}
    {!resource.data && !resource.error ? <Loading /> : resource.data?.items.length === 0 ? search.get('q') || search.get('health') && search.get('health') !== 'all' ? <EmptyState title={t('noResults')} action={<Button variant="flat" onPress={() => setSearch({})}>{t('clearFilters')}</Button>} /> : <EmptyState art={<Rss size={32} />} title={t('empty')} hint={t('emptyHint')} action={<Button as={Link} to="/admin/subscriptions/library" color="primary">{t('browse')}</Button>} /> : <div className="polaris-card divide-y divide-divider">
      {resource.data?.items.map(row => <article key={row.id} className="flex flex-wrap items-center gap-4 p-4 sm:p-5">
        <Checkbox aria-label={t('selectItem', { name: row.name })} isDisabled={busy} isSelected={selected.has(row.id)} onValueChange={value => setSelected(previous => { const next = new Set(previous); value ? next.add(row.id) : next.delete(row.id); return next; })} />
        <div className="min-w-40 flex-1"><Link className="text-medium font-semibold hover:text-primary" to={`/admin/subscriptions/${row.id}`}>{row.name}</Link><p className="mt-1 text-small text-default-500">{t(row.category)} · {row.templateName} {row.templateVersion}{row.sourceHosts?.length ? ` · ${row.sourceHosts.join(', ')}` : ''}</p></div>
        <div className="min-w-32 text-small"><Status value={subscriptionHealth(row)} /><p className="mt-1 text-default-500"><Timestamp value={row.runtime.lastSuccessAt} /></p>{row.configUpdate?.changed ? <Link to={`/admin/subscriptions/${row.id}/config`} className="mt-1 block text-primary underline">{t(row.configUpdate.conflict ? 'versionConflict' : 'updateAvailable', { version: row.configUpdate.version || row.templateVersion })}</Link> : null}</div>
        <p className="text-small text-default-500">{t('itemCounts', { selected: row.runtime.selectedCount, discovered: row.runtime.itemCount - row.runtime.selectedCount })}<span className="mt-1 flex flex-wrap gap-2">{Object.entries(row.statusCounts ?? {}).filter(([, count]) => count).map(([status, count]) => <span key={status}><Status value={status} /> {count}</span>)}</span></p>
        <Button size="sm" variant="flat" isDisabled={busy || !row.enabled || row.archivedAt !== null} onPress={() => void sync(row.id)} startContent={<RefreshCw size={14} />}>{t('sync')}</Button>
      </article>)}
    </div>}
    {resource.data ? <Pagination total={resource.data.total} nextOffset={resource.data.nextOffset} /> : null}
  </AdminPage>;
}
