import { Button, Input, SelectItem } from '@heroui/react';
import { Select } from '@/components/ui/MotionOverlays';
import { ArrowUpRight, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Link, useSearchParams, useNavigate } from 'react-router';
import useSWR from 'swr';
import { useTranslations } from 'use-intl';
import { OFFICIAL_SUBSCRIPTION_REPOSITORY, OFFICIAL_SUBSCRIPTION_ROOT } from '../../../../shared/subscription-templates';
import { useBackendCapabilities } from '@/api/backend';
import { AdminPage } from '../layout/AdminPage';
import { EmptyState } from '../components/ConsolePrimitives';
import { subscriptionsApi } from './api';
import { CategorySwitch, Failure, Loading, Pagination, SubscriptionTabs, Timestamp } from './Parts';

export function SubscriptionLibrary({ templateId }: { templateId?: string }) {
  const t = useTranslations('admin.subscriptions'), navigate = useNavigate(), [search, setSearch] = useSearchParams();
  const catalog = useSWR('console:subscription-catalog', subscriptionsApi.catalog, { shouldRetryOnError: false });
  const template = useSWR(templateId ? ['console:subscription-template', templateId] : null, () => subscriptionsApi.template(templateId!), { shouldRetryOnError: false });
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const refresh = async () => { setBusy(true); setError(undefined); try { await catalog.mutate(await subscriptionsApi.refreshCatalog(), false); } catch (error) { setError(error); } finally { setBusy(false); } };
  const set = (key: string, value: string) => { const next = new URLSearchParams(search); next.set(key, value); next.delete('offset'); setSearch(next, { replace: true }); };
  const offset = Math.max(0, Number(search.get('offset')) || 0);
  const descriptor = template.data?.descriptor;
  const engine = useBackendCapabilities().data?.subscriptions;
  const supported = !descriptor || Boolean(engine?.supported && descriptor.capabilities.every(capability => engine.capabilities.includes(capability)));
  const entry = catalog.data?.entries.find(entry => entry.id === templateId);
  const rows = catalog.data?.entries.filter(entry => (!search.get('category') || search.get('category') === 'all' || entry.categories.includes(search.get('category') as 'website' | 'model')) && (!search.get('kind') || search.get('kind') === 'all' || entry.kind === search.get('kind')) && (!search.get('origin') || search.get('origin') === 'all' || entry.origin === search.get('origin')) && `${entry.name} ${entry.description}`.toLowerCase().includes((search.get('q') || '').toLowerCase()));
  return <AdminPage title={descriptor?.name || t('library')} description={templateId ? descriptor?.description : t('libraryDescription')} back={templateId ? { href: '/admin/subscriptions/library', label: t('library') } : undefined} actions={<><Button as="a" href={OFFICIAL_SUBSCRIPTION_REPOSITORY} target="_blank" rel="noreferrer" variant="light" endContent={<ArrowUpRight size={14} />}>{t('officialRepository')}</Button><Button variant="flat" isLoading={busy} onPress={() => void refresh()} startContent={<RefreshCw size={14} />}>{t('refresh')}</Button></>}>
    <SubscriptionTabs /><Failure error={error || catalog.error || template.error} retry={() => void refresh()} />
    {catalog.data?.stale ? <p role="status" className="mb-4 rounded-medium bg-warning-50 p-4 text-small text-warning-700">{t('cachedCatalog')} · <Timestamp value={catalog.data.fetchedAt} /></p> : null}
    {templateId ? !descriptor && !template.error ? <Loading /> : descriptor ? <div className="max-w-3xl space-y-6 pb-8">
      <div className="flex flex-wrap items-center gap-3 text-small"><span>{descriptor.version}</span>{descriptor.categories.map(category => <span key={category}>{t(category)}</span>)}<span>{t('verified')} <time>{entry?.verifiedAt || t('notVerified')}</time></span></div>
      <div className="flex flex-wrap gap-3"><Button as={Link} to={`/admin/subscriptions/new?template=${encodeURIComponent(templateId)}`} color="primary" isDisabled={!supported}>{t(entry?.kind === 'site' ? 'add' : 'configureAdd')}</Button>{templateId.startsWith('local-') ? <Button variant="light" color="danger" isDisabled={busy} onPress={() => { if (!window.confirm(t('removeConfigHint'))) return; setBusy(true); void subscriptionsApi.removeConfig(templateId).then(async () => { await catalog.mutate(); navigate('/admin/subscriptions/library'); }).catch(setError).finally(() => setBusy(false)); }}>{t('removeConfig')}</Button> : null}</div>
      <section><h2 className="mb-3 font-semibold">{t('parameters')}</h2><dl className="divide-y divide-divider">{Object.entries(descriptor.inputs).map(([key, input]) => <div key={key} className="grid gap-1 py-3 sm:grid-cols-3"><dt className="text-small font-medium">{input.label || key}{input.required ? ' *' : ''}</dt><dd className="break-words text-small text-default-500 sm:col-span-2">{input.description || (input.type === 'secret' ? t('secretRequired') : String(input.default ?? input.type))}</dd></div>)}</dl></section>
      <section><h2 className="mb-2 font-semibold">{t('capabilities')}</h2><p className="text-small text-default-500">{descriptor.capabilities.join(' · ')}</p>{entry?.limitations.map(value => <p key={value} className="mt-2 text-small text-default-500">{value}</p>)}</section>
      {!supported ? <Failure error="subscription_schema_unsupported" /> : null}
      {entry?.origin === 'official' && entry.versions?.length ? <section><h2 className="mb-2 font-semibold">{t('history')}</h2><ul className="flex flex-wrap gap-4 text-small">{entry.versions.filter(value => value.path === `${entry.path.split('/').slice(0,-1).join('/')}/${value.version}.json` && /^\d+\.\d+\.\d+$/.test(value.version)).map(value => <li key={value.version}><a href={new URL(value.path, OFFICIAL_SUBSCRIPTION_ROOT).href} target="_blank" rel="noreferrer" className="text-primary underline">{value.version}</a></li>)}</ul></section> : null}
      <details><summary className="cursor-pointer text-small font-medium">{t('descriptor')}</summary><pre className="mt-3 max-h-96 overflow-auto rounded-medium bg-default-100 p-4 text-small">{JSON.stringify(descriptor, null, 2)}</pre></details>
    </div> : null : <>
      <div className="mb-5 flex flex-wrap items-center gap-3"><CategorySwitch all value={search.get('category') || 'all'} onChange={value => set('category', value)} /><Input size="sm" className="min-w-48 flex-1" aria-label={t('search')} placeholder={t('search')} value={search.get('q') || ''} onValueChange={value => set('q', value)} /><Select className="w-36" size="sm" aria-label={t('kind')} selectedKeys={[search.get('kind') || 'all']} onChange={event => set('kind', event.target.value)}>{['all', 'template', 'site'].map(key => <SelectItem key={key}>{t(key)}</SelectItem>)}</Select><Select className="w-36" size="sm" aria-label={t('origin')} selectedKeys={[search.get('origin') || 'all']} onChange={event => set('origin', event.target.value)}>{['all', 'official', 'local'].map(key => <SelectItem key={key}>{t(key)}</SelectItem>)}</Select></div>
      {!catalog.data && !catalog.error ? <Loading /> : !rows?.length ? <EmptyState title={t('noResults')} action={<Button variant="flat" onPress={() => setSearch({})}>{t('clearFilters')}</Button>} /> : <div className="polaris-card divide-y divide-divider">{rows.slice(offset, offset + 50).map(entry => <article key={entry.id} className="flex flex-wrap items-center gap-x-6 gap-y-3 p-5"><div className="min-w-48 flex-1"><div className="flex flex-wrap items-center gap-2"><Link to={`/admin/subscriptions/library/${encodeURIComponent(entry.id)}`} className="text-medium font-semibold hover:text-primary">{entry.name}</Link><span className="text-small text-default-500">{entry.version}</span></div><p className="mt-1 max-w-2xl text-small text-default-500">{entry.description}</p><p className="mt-2 text-small text-default-500">{t(entry.origin)} · {t(entry.kind)} · {entry.categories.map(category => t(category)).join(' / ')}{entry.installedCount ? ` · ${t('installed')}` : ''}</p></div><Button as={Link} to={`/admin/subscriptions/new?template=${encodeURIComponent(entry.id)}`} variant="flat" color="primary">{t(entry.kind === 'site' ? 'add' : 'configureAdd')}</Button></article>)}</div>}
      {rows ? <Pagination total={rows.length} nextOffset={offset + 50 < rows.length ? offset + 50 : null} /> : null}
    </>}
  </AdminPage>;
}
