import { Button, Checkbox, SelectItem, Textarea } from '@heroui/react';
import { Select } from '@/components/ui/MotionOverlays';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'use-intl';
import type { SubscriptionConfig, SubscriptionDescriptor, SubscriptionPreview } from '../../../../shared/subscriptions';
import { validateSubscriptionDescriptor } from '../../../../shared/subscription-validation';
import { AdminPage } from '../layout/AdminPage';
import { subscriptionsApi, useSubscription } from './api';
import { DetailTabs, Failure, FieldGroup, Loading, ParameterFields, Status, useDraftWarning, useSubscriptionError } from './Parts';

export function SubscriptionConfigEditor({ id }: { id: string }) {
  const t = useTranslations('admin.subscriptions'), subscription = useSubscription(id);
  const resource = useSWR(['console:subscription-config', id], () => subscriptionsApi.config(id), { shouldRetryOnError: false, revalidateOnFocus: false });
  return <AdminPage title={t('config')} back={{ href: `/admin/subscriptions/${id}`, label: subscription.data?.subscription.name || t('mine') }}>
    <DetailTabs id={id} active="config" /><Failure error={resource.error} retry={() => void resource.mutate()} />
    {!resource.data && !resource.error ? <Loading /> : resource.data ? <Editor key={resource.data.revision} id={id} config={resource.data.config} revision={resource.data.revision} onSaved={async () => { await Promise.all([resource.mutate(), subscription.mutate()]); }} /> : null}
  </AdminPage>;
}
function Editor({ id, config, revision, onSaved }: { id: string; config: SubscriptionConfig; revision: string; onSaved: () => Promise<void> }) {
  const t = useTranslations('admin.subscriptions'), describe = useSubscriptionError();
  const [text, setText] = useState(JSON.stringify(config.descriptor, null, 2)), [parameters, setParameters] = useState(config.parameters);
  const [preview, setPreview] = useState<SubscriptionPreview>(), [update, setUpdate] = useState<{ changed: boolean; conflict: boolean; candidate: SubscriptionDescriptor }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [saved, setSaved] = useState(false);
  const [identityConfirmed, setIdentityConfirmed] = useState(false), [identityMappings, setIdentityMappings] = useState<Record<string, string>>({});
  useEffect(() => { let active = true; if (config.sourceUrl) void subscriptionsApi.checkUpdate(id).then(result => { if (active) setUpdate(result); }).catch(() => {}); return () => { active = false; }; }, [id, config.sourceUrl]);
  useDraftWarning(!saved && (text !== JSON.stringify(config.descriptor, null, 2) || JSON.stringify(parameters) !== JSON.stringify(config.parameters)));
  let descriptor: SubscriptionDescriptor | undefined;
  try { descriptor = validateSubscriptionDescriptor(JSON.parse(text)); } catch {}
  const act = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(undefined); try { await work(); } catch (error) { setError(error); } finally { setBusy(false); } };
  const readPreview = (rollback = false) => act(async () => { const result = await subscriptionsApi.previewConfig(id, { revision, descriptor: JSON.parse(text), parameters, rollback }); setPreview(result.preview); setIdentityConfirmed(false); setIdentityMappings({}); if (rollback) { setText(JSON.stringify(result.preview.config.descriptor, null, 2)); setParameters(result.preview.config.parameters); } if (result.preview.state === 'failed') setError(result.preview.error); });
  const apply = () => act(async () => { await subscriptionsApi.applyConfig(id, { revision, previewId: preview?.id, confirmIdentityChange: identityConfirmed, identityMappings: Object.entries(identityMappings).filter(([, sourceItemId]) => sourceItemId).map(([itemId, sourceItemId]) => ({ itemId, sourceItemId })) }); setSaved(true); await onSaved(); });
  const changed = descriptor ? ['requests', 'inputs', 'items', 'observations', 'metrics'].filter(key => JSON.stringify(config.descriptor[key as keyof SubscriptionDescriptor]) !== JSON.stringify(descriptor![key as keyof SubscriptionDescriptor])) : [];
  return <div className="space-y-6 pb-8"><Failure error={error} />
    <div className="flex flex-wrap items-center gap-3 text-small text-default-500"><span>{config.descriptor.name} {config.descriptor.version}</span><span>{t(config.modified ? 'locallyModified' : config.origin)}</span>{config.sourceUrl ? <a href={config.sourceUrl} target="_blank" rel="noreferrer" className="max-w-full truncate text-primary underline">{t('sourceFile')}</a> : null}</div>
    <div className="flex flex-wrap gap-3"><Button variant="flat" isDisabled={busy || !config.sourceUrl} onPress={() => void act(async () => setUpdate(await subscriptionsApi.checkUpdate(id)))}>{t('checkUpdate')}</Button><Button as="a" variant="flat" href={`/api/admin/subscriptions/${encodeURIComponent(id)}/config/export`} download>{t('export')}</Button><Button variant="light" isDisabled={busy} onPress={() => void readPreview(true)}>{t('rollbackPreview')}</Button></div>
    {update ? <div role="status" className={`rounded-medium p-4 text-small ${update.conflict ? 'bg-warning-50 text-warning-700' : 'bg-default-100'}`}><p>{t(update.conflict ? 'versionConflict' : update.changed ? 'updateAvailable' : 'upToDate', { version: update.candidate.version })}</p>{update.changed ? <Button className="mt-3" size="sm" variant="flat" onPress={() => { setText(JSON.stringify(update.candidate, null, 2)); setPreview(undefined); }}>{t('compareUpdate')}</Button> : null}</div> : null}
    <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]"><section className="min-w-0 space-y-3"><Textarea label={t('descriptor')} value={text} onValueChange={value => { setText(value); setPreview(undefined); }} minRows={20} maxRows={40} spellCheck="false" isDisabled={busy} classNames={{ input: 'font-mono text-small leading-relaxed' }} /><Button size="sm" variant="light" isDisabled={busy} onPress={() => void act(async () => setText(JSON.stringify(JSON.parse(text), null, 2)))}>{t('format')}</Button></section><div className="min-w-0 space-y-6">
      {descriptor?.inputs && typeof descriptor.inputs === 'object' ? <FieldGroup title={t('parameters')}><ParameterFields descriptor={descriptor} parameters={parameters} secrets={config.secretNames} disabled={busy} onChange={value => { setParameters(value); setPreview(undefined); }} /></FieldGroup> : null}
      <FieldGroup title={t('changes')}><p className="text-small text-default-500">{changed.length ? changed.map(key => t(`changed.${key}`)).join('、') : t('noDescriptorChanges')}</p><details><summary className="cursor-pointer text-small">{t('currentVersion')}</summary><pre className="mt-3 max-h-80 overflow-auto bg-default-100 p-4 text-small">{JSON.stringify(config.descriptor, null, 2)}</pre></details></FieldGroup>
      {preview ? <FieldGroup title={t('preview')}><Status value={preview.state} /><p className="text-small">{t('total', { count: preview.items.length })}</p><ul className="max-h-64 overflow-auto text-small">{preview.items.map(item => <li key={item.sourceItemId} className="flex justify-between gap-3 py-2"><span>{item.name} · {item.sourceItemId}</span><Status value={item.observation?.status || 'unknown'} /></li>)}</ul>{preview.issues.map((issue, index) => <p key={index} className="text-small text-warning">{issue.path} · {describe(issue.code)}</p>)}</FieldGroup> : null}
    </div></div>
    {preview?.identity ? <FieldGroup title={t('identityChanges')}><p className="text-small text-default-500">{t('identityCounts', { added: preview.identity.added.length, removed: preview.identity.removed.length })}</p>{preview.identity.changed ? <><p className="text-small text-warning">{t('identityHint')}</p><div className="max-h-96 space-y-3 overflow-auto">{preview.identity.previous.map(item => <Select key={item.id} label={`${item.name} · ${item.sourceItemId}`} selectedKeys={[identityMappings[item.id] || '']} onChange={event => { setIdentityMappings(previous => ({ ...previous, [item.id]: event.target.value })); setIdentityConfirmed(false); }}>{[{ sourceItemId: '', name: t('archiveIdentity') }, ...preview.items.filter(next => !Object.entries(identityMappings).some(([key, value]) => key !== item.id && value === next.sourceItemId))].map(next => <SelectItem key={next.sourceItemId}>{next.name}{next.sourceItemId ? ' · ' + next.sourceItemId : ''}</SelectItem>)}</Select>)}</div><Checkbox isSelected={identityConfirmed} onValueChange={setIdentityConfirmed}>{t('confirmIdentity')}</Checkbox></> : <div className="text-small"><p>{t('identityAdded')}: {preview.identity.added.join(', ') || '—'}</p><p>{t('identityRemoved')}: {preview.identity.removed.join(', ') || '—'}</p></div>}</FieldGroup> : null}
    <div className="flex flex-wrap gap-3"><Button variant="flat" isLoading={busy} onPress={() => void readPreview()}>{t('readPreview')}</Button><Button color="primary" isDisabled={busy || preview?.state !== 'ready' || preview.identity?.changed && !identityConfirmed} onPress={() => void apply()}>{t('applyConfig')}</Button></div>
  </div>;
}
