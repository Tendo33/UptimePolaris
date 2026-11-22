import { useBackendCapabilities } from '@/api/backend';
import { Segmented } from '@/components/ui/Segmented';
import { Button, Input } from '@heroui/react';
import clsx from 'clsx';
import { ArrowUpRight, BadgeCheck, Bot, Braces, Check, ChevronRight, Database, FileJson, Globe, KeyRound, LayoutTemplate, Plus, RefreshCw, Search, ShieldAlert, Trash2, X } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import useSWR, { type SWRResponse } from 'swr';
import { useTranslations } from 'use-intl';
import { OFFICIAL_SUBSCRIPTION_REPOSITORY, OFFICIAL_SUBSCRIPTION_ROOT } from '../../../../shared/subscription-templates';
import type { SubscriptionCatalogEntry } from '../../../../shared/subscriptions';
import { EmptyState } from '../components/ConsolePrimitives';
import { SearchArt } from '../components/illustrations';
import { AdminPage } from '../layout/AdminPage';
import { usePresentation } from '../settings/presentation-api';
import { AnimatePresence, motion, useIsPresent } from 'framer-motion';
import { CONTENT_TRANSITION } from '@/lib/motion';
import { useReducedMotion } from '@/lib/useReducedMotion';
import { subscriptionsApi, type Catalog } from './api';
import { CategorySwitch, Failure, FieldGroup, Note, Pagination, SubscriptionTabs, SubscriptionContent, Tag, Timestamp } from './Parts';

const PAGE = 48;

export function SubscriptionLibraryActions({ busy, onRefresh, onManage }: { busy: boolean; onRefresh: () => void; onManage?: () => void }) {
  const t = useTranslations('admin.subscriptions');
  return <>
    <Button as="a" href={OFFICIAL_SUBSCRIPTION_REPOSITORY} target="_blank" rel="noreferrer" variant="light" endContent={<ArrowUpRight size={14} />}>{t('officialRepository')}</Button>
    {onManage ? <Button variant="bordered" startContent={<Database size={15} />} onPress={onManage}>{t('manageRepositories')}</Button> : null}
    <Button variant="bordered" isLoading={busy} onPress={onRefresh} startContent={busy ? undefined : <RefreshCw size={14} />}>{t('refresh')}</Button>
  </>;
}

export function SubscriptionLibrary({ templateId, embedded = false }: { templateId?: string; embedded?: boolean }) {
  const t = useTranslations('admin.subscriptions');
  const aiEnabled = usePresentation().data?.config.aiEnabled === true;
  const [search, setSearch] = useSearchParams();
  const catalog = useSWR('console:subscription-catalog', subscriptionsApi.catalog, { shouldRetryOnError: false });
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const refresh = async () => { setBusy(true); setError(undefined); try { await catalog.mutate(await subscriptionsApi.refreshCatalog(), false); } catch (cause) { setError(cause); } finally { setBusy(false); } };

  const actions = <SubscriptionLibraryActions busy={busy} onRefresh={() => void refresh()} />;

  if (templateId) return <TemplateDetail templateId={templateId} catalog={catalog} actions={actions} error={error} />;

  const set = (key: string, value: string) => { const next = new URLSearchParams(search); if (!value || value === 'all') next.delete(key); else next.set(key, value); next.delete('offset'); setSearch(next, { replace: true }); };
  const offset = Math.max(0, Number(search.get('offset')) || 0);
  const category = search.get('category') || 'all', kind = search.get('kind') || 'all', origin = search.get('origin') || 'all', q = (search.get('q') || '').toLowerCase();
  const entries = (catalog.data?.entries ?? []).map(entry => ({ ...entry, categories: entry.categories.filter(category => aiEnabled || category !== 'model') })).filter(entry => entry.categories.length);
  const rows = entries.filter(entry => (category === 'all' || entry.categories.includes(category as 'website' | 'model')) && (kind === 'all' || entry.kind === kind) && (origin === 'all' || entry.origin === origin) && `${entry.name} ${entry.description}`.toLowerCase().includes(q));
  const filtered = category !== 'all' || kind !== 'all' || origin !== 'all' || Boolean(q);

  return (
    <SubscriptionContent embedded={embedded} title={t('library')} description={t('libraryDescription')} actions={actions}>
      {!embedded ? <SubscriptionTabs counts={catalog.data ? { library: entries.length } : undefined} /> : null}
      <Failure error={error || catalog.error} retry={() => void refresh()} />
      {catalog.data?.stale ? <Note tone="warn" className="mb-4">{t('cachedCatalog')} · <Timestamp value={catalog.data.fetchedAt} /></Note> : null}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <CategorySwitch all value={category} onChange={value => set('category', value)} />
        <Segmented label={t('kind')} value={kind} onChange={value => set('kind', value)} options={['all', 'site', 'template'].map(key => ({ value: key, label: key === 'all' ? t('allKinds') : t(key) }))} />
        <Segmented label={t('origin')} value={origin} onChange={value => set('origin', value)} options={['all', 'official', 'third-party', 'local'].map(key => ({ value: key, label: key === 'all' ? t('allOrigins') : key === 'third-party' ? t('thirdParty') : t(key) }))} />
        <Input
          size="sm"
          className="w-full sm:ml-auto sm:w-64"
          aria-label={t('searchLibrary')}
          placeholder={t('searchLibrary')}
          value={search.get('q') || ''}
          onValueChange={value => set('q', value)}
          startContent={<Search className="shrink-0 text-[var(--polaris-ink-4)]" size={14} />}
          endContent={q ? <button type="button" aria-label={t('cancel')} onClick={() => set('q', '')} className="text-[var(--polaris-ink-4)] hover:text-[var(--polaris-ink)]"><X size={14} /></button> : null}
        />
      </div>

      {!catalog.data && !catalog.error ? (
        <div aria-busy="true" className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {Array.from({ length: 6 }, (_, index) => <div key={index} className="polaris-card polaris-shimmer h-44" />)}
        </div>
      ) : !rows.length ? (
        <div className="polaris-card">
          <EmptyState art={<SearchArt />} title={t('noResults')} action={filtered ? <Button size="sm" variant="bordered" onPress={() => setSearch({})}>{t('clearFilters')}</Button> : undefined} />
        </div>
      ) : (
        <>
          <ul className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
            <AnimatePresence initial={false}>{rows.slice(offset, offset + PAGE).map(entry => <TemplateCard key={entry.id} entry={entry} />)}</AnimatePresence>
            <li>
              <Link to="/admin/subscriptions/new?source=json" className="flex h-full min-h-44 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-[var(--polaris-line)] p-5 text-center text-[var(--polaris-ink-3)] transition-colors hover:border-[var(--polaris-ink-4)] hover:bg-[var(--polaris-hover)] hover:text-[var(--polaris-ink)]">
                <FileJson size={22} aria-hidden="true" />
                <span className="text-[13.5px] font-medium">{t('importOwn')}</span>
                <span className="max-w-[16rem] text-[12px] leading-relaxed text-[var(--polaris-ink-4)]">{t('importOwnHint')}</span>
              </Link>
            </li>
          </ul>
          <div className="py-4"><Pagination total={rows.length} pageSize={PAGE} nextOffset={offset + PAGE < rows.length ? offset + PAGE : null} /></div>
        </>
      )}
    </SubscriptionContent>
  );
}

function CategoryGlyphs({ categories }: { categories: SubscriptionCatalogEntry['categories'] }) {
  return (
    <span className="flex -space-x-1.5">
      {categories.map(category => {
        const Icon = category === 'model' ? Bot : Globe;
        return (
          <span key={category} aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-card)] text-[var(--polaris-ink-2)] shadow-[0_1px_2px_rgb(0_0_0/0.04)]">
            <Icon size={17} />
          </span>
        );
      })}
    </span>
  );
}

function TemplateCard({ entry }: { entry: SubscriptionCatalogEntry }) {
  const t = useTranslations('admin.subscriptions');
  const reduced = useReducedMotion();
  const present = useIsPresent();
  const href = `/admin/subscriptions/library/${encodeURIComponent(entry.id)}`;
  return (
    <motion.li inert={!present} aria-hidden={!present || undefined} layout={reduced ? false : 'position'} initial={{ opacity: reduced ? 1 : 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={reduced ? { duration: 0 } : CONTENT_TRANSITION} className="polaris-card group relative flex min-h-44 flex-col p-5 transition-shadow hover:shadow-[0_6px_20px_-12px_rgb(0_0_0/0.25)]">
      <div className="flex items-start gap-3">
        <CategoryGlyphs categories={entry.categories} />
        <div className="ml-auto flex flex-wrap justify-end gap-1">
          {entry.installedCount ? <Tag tone="success"><Check size={11} />{t('installed')}</Tag> : null}
          <Tag tone={entry.origin === 'official' ? 'primary' : 'default'}>{entry.origin === 'official' ? <BadgeCheck size={11} /> : null}{entry.repositoryName || t(entry.origin === 'third-party' ? 'thirdParty' : entry.origin)}</Tag>
        </div>
      </div>
      <div className="mt-3 flex min-w-0 items-baseline gap-2">
        <Link to={href} className="min-w-0 truncate text-[15px] font-semibold text-[var(--polaris-ink)] after:absolute after:inset-0 after:content-['']">{entry.name}</Link>
        <span className="polaris-num shrink-0 text-[11.5px] text-[var(--polaris-ink-4)]">{entry.version}</span>
      </div>
      <p className="mt-1 line-clamp-2 text-[12.5px] leading-relaxed text-[var(--polaris-ink-3)]">{entry.description}</p>
      <div className="mt-auto flex items-center gap-2 pt-4 text-[12px] text-[var(--polaris-ink-3)]">
        <span className="flex items-center gap-1">{entry.kind === 'site' ? <Globe size={12} /> : <LayoutTemplate size={12} />}{t(entry.kind)}</span>
        <span aria-hidden="true" className="text-[var(--polaris-ink-4)]">·</span>
        <span className="truncate">{entry.categories.map(category => t(category)).join(' / ')}</span>
        <Button as={Link} to={`/admin/subscriptions/new?template=${encodeURIComponent(entry.id)}`} size="sm" variant="flat" className="relative z-10 ml-auto shrink-0" startContent={<Plus size={14} />}>
          {t(entry.kind === 'site' ? 'add' : 'configureAdd')}
        </Button>
      </div>
    </motion.li>
  );
}

function TemplateDetail({ templateId, catalog, actions, error }: { templateId: string; catalog: SWRResponse<Catalog>; actions: React.ReactNode; error: unknown }) {
  const t = useTranslations('admin.subscriptions');
  const navigate = useNavigate();
  const template = useSWR(['console:subscription-template', templateId], () => subscriptionsApi.template(templateId), { shouldRetryOnError: false });
  const engine = useBackendCapabilities().data?.subscriptions;
  const [busy, setBusy] = useState(false), [removeError, setRemoveError] = useState<unknown>();
  const descriptor = template.data?.descriptor;
  const entry = catalog.data?.entries.find(item => item.id === templateId);
  const supported = !descriptor || Boolean(engine?.supported && descriptor.capabilities.every(capability => engine.capabilities.includes(capability)));
  const missing = descriptor && engine ? descriptor.capabilities.filter(capability => !engine.capabilities.includes(capability)) : [];
  const inputs = descriptor ? Object.entries(descriptor.inputs) : [];
  const versions = entry?.origin === 'official' ? (entry.versions ?? []).filter(value => value.path === `${entry.path.split('/').slice(0, -1).join('/')}/${value.version}.json` && /^\d+\.\d+\.\d+$/.test(value.version)) : [];
  const remove = () => {
    if (!window.confirm(t('removeConfigHint'))) return;
    setBusy(true); setRemoveError(undefined);
    void subscriptionsApi.removeConfig(templateId).then(async () => { await catalog.mutate(); navigate('/admin/subscriptions/library'); }).catch(setRemoveError).finally(() => setBusy(false));
  };

  return (
    <AdminPage title={descriptor?.name || entry?.name || t('library')} description={descriptor?.description || entry?.description} back={{ href: '/admin/subscriptions/library', label: t('library') }} actions={actions}>
      <Failure error={error || removeError || template.error} retry={() => void template.mutate()} />
      {!descriptor && !template.error ? (
        <div aria-busy="true" className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="polaris-card polaris-shimmer h-72" />
          <div className="polaris-card polaris-shimmer h-56" />
        </div>
      ) : descriptor ? (
        <div className="grid items-start gap-5 pb-8 lg:grid-cols-[minmax(0,1fr)_20rem]">
          <div className="min-w-0 space-y-5">
            {!supported ? (
              <Note tone="warn">
                <p className="font-medium">{t('errors.subscription_schema_unsupported')}</p>
                {missing.length ? <p className="mt-1 font-mono text-[11.5px]">{missing.join(' · ')}</p> : null}
              </Note>
            ) : null}

            <FieldGroup title={t('parameters')} icon={<KeyRound />} description={inputs.length ? t('parametersHint', { count: inputs.length }) : undefined}>
              {inputs.length ? (
                <dl className="-my-1 divide-y divide-[var(--polaris-line-soft)]">
                  {inputs.map(([key, input]) => (
                    <div key={key} className="grid gap-1 py-3 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-4">
                      <dt className="flex flex-wrap items-center gap-1.5 text-[13px] font-medium text-[var(--polaris-ink)]">
                        {input.label || key}
                        {input.required ? <Tag tone="danger">{t('required')}</Tag> : null}
                        {input.type === 'secret' ? <Tag><KeyRound size={10} />{t('secret')}</Tag> : null}
                      </dt>
                      <dd className="min-w-0 break-words text-[12.5px] leading-relaxed text-[var(--polaris-ink-3)]">
                        {input.description || (input.type === 'secret' ? t('secretRequired') : null)}
                        <span className="mt-0.5 block font-mono text-[11.5px] text-[var(--polaris-ink-4)]">
                          {key} · {input.type}{input.default !== undefined ? ` = ${String(input.default)}` : ''}
                        </span>
                      </dd>
                    </div>
                  ))}
                </dl>
              ) : <p className="text-[13px] text-[var(--polaris-ink-3)]">{t('noParameters')}</p>}
            </FieldGroup>

            <FieldGroup title={t('capabilities')} icon={<BadgeCheck />}>
              <div className="flex flex-wrap gap-1.5">
                {descriptor.capabilities.map(capability => <Tag key={capability} tone={engine && !engine.capabilities.includes(capability) ? 'warning' : 'default'} className="font-mono">{capability}</Tag>)}
              </div>
              {entry?.limitations.length ? (
                <ul className="space-y-1.5">
                  {entry.limitations.map(value => (
                    <li key={value} className="flex gap-2 text-[12.5px] leading-relaxed text-[var(--polaris-ink-3)]">
                      <ShieldAlert size={14} className="mt-0.5 shrink-0 text-warning-600" aria-hidden="true" />
                      {value}
                    </li>
                  ))}
                </ul>
              ) : null}
            </FieldGroup>

            <details className="polaris-card group overflow-hidden">
              <summary className="flex cursor-pointer list-none items-center gap-2 px-5 py-4 text-[14px] font-semibold text-[var(--polaris-ink)] [&::-webkit-details-marker]:hidden">
                <Braces size={15} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
                {t('descriptor')}
                <ChevronRight size={15} className="ml-auto text-[var(--polaris-ink-4)] transition-transform group-open:rotate-90" aria-hidden="true" />
              </summary>
              <pre className="max-h-[28rem] overflow-auto border-t border-[var(--polaris-line-soft)] bg-[var(--polaris-well)] px-5 py-4 font-mono text-[12px] leading-relaxed text-[var(--polaris-ink-2)]">{JSON.stringify(descriptor, null, 2)}</pre>
            </details>
          </div>

          <aside className="polaris-card space-y-4 p-5 lg:sticky lg:top-4">
            <div className="flex items-center gap-3">
              <CategoryGlyphs categories={descriptor.categories} />
              <div className="min-w-0">
                <p className="truncate text-[14px] font-semibold text-[var(--polaris-ink)]">{descriptor.name}</p>
                <p className="polaris-num text-[12px] text-[var(--polaris-ink-3)]">v{descriptor.version}</p>
              </div>
            </div>
            <Button as={Link} to={`/admin/subscriptions/new?template=${encodeURIComponent(templateId)}`} color="primary" fullWidth isDisabled={!supported} startContent={<Plus size={15} />}>
              {t(entry?.kind === 'site' ? 'add' : 'configureAdd')}
            </Button>
            <dl className="space-y-2.5 border-t border-[var(--polaris-line-soft)] pt-4 text-[12.5px]">
              {[
                [t('category'), descriptor.categories.map(category => t(category)).join(' / ')],
                [t('kind'), entry ? t(entry.kind) : '—'],
                [t('origin'), entry?.repositoryName || (entry ? t(entry.origin === 'third-party' ? 'thirdParty' : entry.origin) : '—')],
                [t('verified'), entry?.verifiedAt || t('notVerified')],
                [t('mode'), t(descriptor.observations.mode === 'heartbeat' ? 'modeHeartbeat' : 'modeSnapshot')],
              ].map(([label, value]) => (
                <div key={label} className="flex items-baseline justify-between gap-3">
                  <dt className="text-[var(--polaris-ink-3)]">{label}</dt>
                  <dd className="min-w-0 truncate text-right font-medium text-[var(--polaris-ink)]">{value}</dd>
                </div>
              ))}
            </dl>
            {entry?.installedCount ? <Note><Check size={13} className="mr-1 inline text-success-600" />{t('installedCount', { count: entry.installedCount })}</Note> : null}
            {versions.length ? (
              <div className="border-t border-[var(--polaris-line-soft)] pt-4">
                <p className="mb-2 text-[12px] text-[var(--polaris-ink-3)]">{t('history')}</p>
                <ul className="flex flex-wrap gap-1.5">
                  {versions.map(value => (
                    <li key={value.version}>
                      <a href={new URL(value.path, OFFICIAL_SUBSCRIPTION_ROOT).href} target="_blank" rel="noreferrer" className={clsx('polaris-num inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11.5px] transition-colors hover:bg-[var(--polaris-hover)]', value.version === descriptor.version ? 'border-[var(--polaris-ink-4)] text-[var(--polaris-ink)]' : 'border-[var(--polaris-line)] text-[var(--polaris-ink-3)]')}>
                        {value.version}<ArrowUpRight size={11} />
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            {templateId.startsWith('local-') ? (
              <Button variant="light" color="danger" fullWidth isLoading={busy} startContent={busy ? undefined : <Trash2 size={14} />} onPress={remove}>{t('removeConfig')}</Button>
            ) : null}
          </aside>
        </div>
      ) : null}
    </AdminPage>
  );
}
