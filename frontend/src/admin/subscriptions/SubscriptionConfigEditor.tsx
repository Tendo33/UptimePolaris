import { Select } from '@/components/ui/MotionOverlays';
import { Button, Checkbox, SelectItem, Textarea } from '@heroui/react';
import { stateTone } from '@/components/subscriptions/observation';
import { StatusDot } from '@/components/ui/StatusDot';
import { Braces, Check, CircleAlert, Download, Eye, FileCode2, GitCompare, History, KeyRound, Link2, RefreshCw, Undo2, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'use-intl';
import type { SubscriptionConfig, SubscriptionDescriptor, SubscriptionPreview } from '../../../../shared/subscriptions';
import { validateSubscriptionDescriptor } from '../../../../shared/subscription-validation';
import { subscriptionsApi } from './api';
import { Failure, FieldGroup, Loading, Note, ParameterFields, Status, Tag, useDraftWarning, useSubscriptionError } from './Parts';

export function SubscriptionConfigEditor({ id, onSaved }: { id: string; onSaved: () => Promise<void> }) {
  const resource = useSWR(['console:subscription-config', id], () => subscriptionsApi.config(id), { shouldRetryOnError: false, revalidateOnFocus: false });
  return (
    <>
      <Failure error={resource.error} retry={() => void resource.mutate()} />
      {!resource.data && !resource.error ? <Loading /> : resource.data ? <Editor key={resource.data.revision} id={id} config={resource.data.config} revision={resource.data.revision} onSaved={async () => { await Promise.all([resource.mutate(), onSaved()]); }} /> : null}
    </>
  );
}

function Editor({ id, config, revision, onSaved }: { id: string; config: SubscriptionConfig; revision: string; onSaved: () => Promise<void> }) {
  const t = useTranslations('admin.subscriptions'), describe = useSubscriptionError();
  const [text, setText] = useState(JSON.stringify(config.descriptor, null, 2)), [parameters, setParameters] = useState(config.parameters);
  const [preview, setPreview] = useState<SubscriptionPreview>(), [update, setUpdate] = useState<{ changed: boolean; conflict: boolean; candidate: SubscriptionDescriptor }>();
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>(), [saved, setSaved] = useState(false);
  const [identityConfirmed, setIdentityConfirmed] = useState(false), [identityMappings, setIdentityMappings] = useState<Record<string, string>>({});
  useEffect(() => { let active = true; if (config.sourceUrl) void subscriptionsApi.checkUpdate(id).then(result => { if (active) setUpdate(result); }).catch(() => {}); return () => { active = false; }; }, [id, config.sourceUrl]);
  const original = JSON.stringify(config.descriptor, null, 2);
  const dirty = !saved && (text !== original || JSON.stringify(parameters) !== JSON.stringify(config.parameters));
  useDraftWarning(dirty);
  let descriptor: SubscriptionDescriptor | undefined;
  let invalid: unknown;
  try { descriptor = validateSubscriptionDescriptor(JSON.parse(text)); } catch (cause) { invalid = cause; }
  const act = async (work: () => Promise<void>) => { if (busy) return; setBusy(true); setError(undefined); try { await work(); } catch (cause) { setError(cause); } finally { setBusy(false); } };
  const readPreview = (rollback = false) => act(async () => { const result = await subscriptionsApi.previewConfig(id, { revision, descriptor: JSON.parse(text), parameters, rollback }); setPreview(result.preview); setIdentityConfirmed(false); setIdentityMappings({}); if (rollback) { setText(JSON.stringify(result.preview.config.descriptor, null, 2)); setParameters(result.preview.config.parameters); } if (result.preview.state === 'failed') setError(result.preview.error); });
  const apply = () => act(async () => { await subscriptionsApi.applyConfig(id, { revision, previewId: preview?.id, confirmIdentityChange: identityConfirmed, identityMappings: Object.entries(identityMappings).filter(([, sourceItemId]) => sourceItemId).map(([itemId, sourceItemId]) => ({ itemId, sourceItemId })) }); setSaved(true); await onSaved(); });
  const changed = descriptor ? ['requests', 'inputs', 'items', 'observations', 'metrics'].filter(key => JSON.stringify(config.descriptor[key as keyof SubscriptionDescriptor]) !== JSON.stringify(descriptor![key as keyof SubscriptionDescriptor])) : [];
  const lines = text.split('\n').length;
  const canApply = !busy && preview?.state === 'ready' && !(preview.identity?.changed && !identityConfirmed);

  return (
    <div className="space-y-5 pb-8">
      <Failure error={error} className="" />

      <section className="polaris-card flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
        <span aria-hidden="true" className="flex h-9 w-9 items-center justify-center rounded-[10px] border border-[var(--polaris-line)] bg-[var(--polaris-well)] text-[var(--polaris-ink-2)]"><FileCode2 size={17} /></span>
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-center gap-2 text-[14px] font-semibold text-[var(--polaris-ink)]">
            {config.descriptor.name}
            <span className="polaris-num text-[12px] font-normal text-[var(--polaris-ink-4)]">v{config.descriptor.version}</span>
            <Tag tone={config.modified ? 'warning' : config.origin === 'official' ? 'primary' : 'default'}>{t(config.modified ? 'locallyModified' : config.origin)}</Tag>
          </p>
          {config.sourceUrl ? (
            <a href={config.sourceUrl} target="_blank" rel="noreferrer" className="mt-0.5 flex min-w-0 items-center gap-1 text-[12px] text-[var(--polaris-ink-3)] hover:text-[var(--polaris-ink)]">
              <Link2 size={12} className="shrink-0" />
              <span className="truncate font-mono text-[11.5px]">{config.sourceUrl}</span>
            </a>
          ) : <p className="mt-0.5 text-[12px] text-[var(--polaris-ink-4)]">{t('noSourceUrl')}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="bordered" isDisabled={busy || !config.sourceUrl} startContent={<RefreshCw size={14} />} onPress={() => void act(async () => setUpdate(await subscriptionsApi.checkUpdate(id)))}>{t('checkUpdate')}</Button>
          <Button size="sm" as="a" variant="bordered" href={`/api/admin/subscriptions/${encodeURIComponent(id)}/config/export`} download startContent={<Download size={14} />}>{t('export')}</Button>
          <Button size="sm" variant="light" isDisabled={busy} startContent={<History size={14} />} onPress={() => void readPreview(true)}>{t('rollbackPreview')}</Button>
        </div>
      </section>

      {update ? (
        <Note tone={update.conflict ? 'warn' : 'info'} align="center">
          <div className="flex flex-wrap items-center gap-3">
            <span className="flex-1">{t(update.conflict ? 'versionConflict' : update.changed ? 'updateAvailable' : 'upToDate', { version: update.candidate.version })}</span>
            {update.changed ? <Button size="sm" variant="flat" startContent={<GitCompare size={14} />} onPress={() => { setText(JSON.stringify(update.candidate, null, 2)); setPreview(undefined); }}>{t('compareUpdate')}</Button> : null}
          </div>
        </Note>
      ) : null}

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
        <section className="polaris-card min-w-0 overflow-hidden">
          <div className="flex flex-wrap items-center gap-2 border-b border-[var(--polaris-line-soft)] px-4 py-2.5">
            <Braces size={15} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
            <span className="text-[13px] font-semibold text-[var(--polaris-ink)]">{t('descriptor')}</span>
            {descriptor ? <Tag tone="success"><Check size={10} />{t('descriptorValid')}</Tag> : <Tag tone="danger" title={describe(invalid)}><CircleAlert size={10} />{t('descriptorInvalid')}</Tag>}
            <span className="polaris-num text-[11.5px] text-[var(--polaris-ink-4)]">{t('lineCount', { count: lines })}</span>
            <div className="ml-auto flex gap-1">
              {text !== original ? <Button size="sm" variant="light" isDisabled={busy} startContent={<Undo2 size={13} />} onPress={() => { setText(original); setPreview(undefined); }}>{t('discard')}</Button> : null}
              <Button size="sm" variant="light" isDisabled={busy} startContent={<Wand2 size={13} />} onPress={() => void act(async () => setText(JSON.stringify(JSON.parse(text), null, 2)))}>{t('format')}</Button>
            </div>
          </div>
          <Textarea
            aria-label={t('descriptor')}
            value={text}
            onValueChange={value => { setText(value); setPreview(undefined); }}
            minRows={22}
            maxRows={44}
            spellCheck="false"
            isDisabled={busy}
            variant="flat"
            classNames={{ inputWrapper: 'rounded-none bg-[var(--polaris-well)] shadow-none data-[hover=true]:bg-[var(--polaris-well)] group-data-[focus=true]:bg-[var(--polaris-well)] px-4 py-3', input: 'font-mono text-[12.5px] leading-relaxed' }}
          />
          {!descriptor && invalid ? <p className="border-t border-danger/20 bg-danger/[0.04] px-4 py-2 text-[12px] text-danger-600">{describe(invalid)}</p> : null}
        </section>

        <div className="min-w-0 space-y-5">
          {descriptor?.inputs && typeof descriptor.inputs === 'object' ? (
            <FieldGroup title={t('parameters')} icon={<KeyRound />}>
              <ParameterFields descriptor={descriptor} parameters={parameters} secrets={config.secretNames} disabled={busy} onChange={value => { setParameters(value); setPreview(undefined); }} />
            </FieldGroup>
          ) : null}

          <FieldGroup title={t('changes')} icon={<GitCompare />}>
            {changed.length ? (
              <div className="flex flex-wrap gap-1.5">{changed.map(key => <Tag key={key} tone="warning">{t(`changed.${key}`)}</Tag>)}</div>
            ) : <p className="text-[13px] text-[var(--polaris-ink-3)]">{t('noDescriptorChanges')}</p>}
            <details className="group">
              <summary className="cursor-pointer text-[12.5px] text-[var(--polaris-ink-3)] hover:text-[var(--polaris-ink)]">{t('currentVersion')}</summary>
              <pre className="mt-3 max-h-80 overflow-auto rounded-lg bg-[var(--polaris-well)] p-3 font-mono text-[11.5px] leading-relaxed text-[var(--polaris-ink-2)]">{original}</pre>
            </details>
          </FieldGroup>

          {preview ? (
            <FieldGroup title={t('preview')} icon={<Eye />} actions={<><Status value={preview.state} /><Tag className="polaris-num">{t('total', { count: preview.items.length })}</Tag></>}>
              <ul className="max-h-72 divide-y divide-[var(--polaris-line-soft)] overflow-auto rounded-xl border border-[var(--polaris-line)]">
                {preview.items.map(item => (
                  <li key={item.sourceItemId} className="flex items-center gap-3 px-3 py-2">
                    <StatusDot tone={stateTone(item.observation?.status || 'unknown')} size={7} />
                    <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--polaris-ink)]">{item.name}</span>
                    <span className="max-w-[40%] truncate font-mono text-[12px] text-[var(--polaris-ink-4)]">{item.sourceItemId}</span>
                  </li>
                ))}
              </ul>
              {preview.issues.length ? (
                <Note tone="warn">
                  <ul className="space-y-1">{preview.issues.map((issue, index) => <li key={index}><span className="font-mono text-[11.5px]">{issue.path}</span> · {describe(issue.code)}</li>)}</ul>
                </Note>
              ) : null}
            </FieldGroup>
          ) : null}
        </div>
      </div>

      {preview?.identity ? (
        <FieldGroup title={t('identityChanges')} icon={<GitCompare />} description={t('identityCounts', { added: preview.identity.added.length, removed: preview.identity.removed.length })}>
          {preview.identity.changed ? (
            <>
              <Note tone="warn">{t('identityHint')}</Note>
              <div className="grid max-h-96 gap-3 overflow-auto sm:grid-cols-2">
                {preview.identity.previous.map(item => (
                  <Select key={item.id} label={`${item.name} · ${item.sourceItemId}`} labelPlacement="outside" placeholder={t('archiveIdentity')} selectedKeys={[identityMappings[item.id] || '']} onChange={event => { setIdentityMappings(previous => ({ ...previous, [item.id]: event.target.value })); setIdentityConfirmed(false); }}>
                    {[{ sourceItemId: '', name: t('archiveIdentity') }, ...preview.items.filter(next => !Object.entries(identityMappings).some(([key, value]) => key !== item.id && value === next.sourceItemId))].map(next => <SelectItem key={next.sourceItemId}>{next.name}{next.sourceItemId ? ' · ' + next.sourceItemId : ''}</SelectItem>)}
                  </Select>
                ))}
              </div>
              <Checkbox isSelected={identityConfirmed} onValueChange={setIdentityConfirmed} classNames={{ label: 'text-[13px]' }}>{t('confirmIdentity')}</Checkbox>
            </>
          ) : (
            <dl className="grid gap-2 text-[12.5px] sm:grid-cols-2">
              <div><dt className="text-[var(--polaris-ink-3)]">{t('identityAdded')}</dt><dd className="mt-0.5 break-words font-mono text-[11.5px] text-[var(--polaris-ink)]">{preview.identity.added.join(', ') || '—'}</dd></div>
              <div><dt className="text-[var(--polaris-ink-3)]">{t('identityRemoved')}</dt><dd className="mt-0.5 break-words font-mono text-[11.5px] text-[var(--polaris-ink)]">{preview.identity.removed.join(', ') || '—'}</dd></div>
            </dl>
          )}
        </FieldGroup>
      ) : null}

      <div className="sticky bottom-[calc(5.5rem+env(safe-area-inset-bottom,0px))] z-20 flex flex-wrap items-center gap-3 rounded-2xl border border-[var(--polaris-line)] bg-[var(--polaris-card)] px-4 py-3 shadow-[0_10px_30px_-16px_rgb(0_0_0/0.35)] lg:bottom-3">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-[var(--polaris-ink-3)]">{preview?.state === 'ready' ? t('previewReady') : dirty ? t('previewRequired') : t('noChanges')}</span>
        <Button variant="bordered" isLoading={busy} isDisabled={!descriptor} startContent={busy ? undefined : <Eye size={14} />} onPress={() => void readPreview()}>{t('readPreview')}</Button>
        <Button color="primary" isDisabled={!canApply} startContent={<Check size={15} />} onPress={() => void apply()}>{t('applyConfig')}</Button>
      </div>
    </div>
  );
}
