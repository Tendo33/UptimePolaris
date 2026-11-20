import type { useManagedUpdates } from '@/api/updates';
import { APP_VERSION } from '@/lib/version';
import { Button, Switch } from '@heroui/react';
import { Download, RefreshCw } from 'lucide-react';
import { useTranslations } from 'use-intl';

function updateErrorKey(error?: string) {
  if (error === 'update_rolled_back') return 'rolledBack';
  if (error === 'update_recovery_failed') return 'recovery';
  if (error === 'update_manual_required') return 'manual';
  if (error === 'update_version_changed') return 'versionChanged';
  if (error === 'update_storage_failed') return 'storage';
  if (/checksum|binary_invalid|image_invalid/.test(error ?? '')) return 'verification';
  if (/network|unavailable|timeout/.test(error ?? '')) return 'network';
  return 'failed';
}

export function UpdateControls({ updater, available }: { updater: ReturnType<typeof useManagedUpdates>; available: boolean }) {
  const t = useTranslations('admin.versionStatus.update');
  const { data, busy, pending, command } = updater;
  const error = updater.actionError ?? data?.error;
  const errorKey = updateErrorKey(error);
  const unreachable = Boolean(updater.error && data?.supported);
  const reconnecting = unreachable && busy;
  if (!data) return <p role="status" className="mx-4 mt-3 text-xs text-[var(--polaris-ink-3)]">{t(updater.error ? 'unreachable' : 'loading')}</p>;
  if (!data.supported) return <p className="mx-4 mt-3 text-xs leading-relaxed text-[var(--polaris-ink-3)]">{t(data.mode === 'docker' ? 'dockerSetup' : 'unavailable')}</p>;
  const changed = data.current.replace(/^v/, '') !== APP_VERSION.replace(/^v/, '') && data.updatedAt > 0;
  return <div className="mx-4 mt-3 space-y-3">
    <Switch size="sm" isSelected={data.automatic} isDisabled={pending || unreachable} onValueChange={(automatic) => void command('policy', { automatic })} classNames={{ base: 'max-w-full', label: 'text-[13px]' }}>
      {t('automatic')}
    </Switch>
    <p className="text-xs leading-relaxed text-[var(--polaris-ink-3)]">{t('automaticHint')}</p>
    {busy || reconnecting ? <p role="status" aria-live="polite" className="flex items-center gap-2 text-xs text-[var(--polaris-accent)]"><RefreshCw size={13} className="shrink-0 motion-safe:animate-spin" />{t(reconnecting ? 'reconnecting' : `phases.${data.phase === 'idle' ? 'checking' : data.phase}`)}</p> : null}
    {error && !busy && !reconnecting ? <p role="alert" className="text-xs leading-relaxed text-danger-600">{t(`errors.${errorKey}`)}</p> : null}
    {unreachable && !reconnecting ? <p role="alert" className="text-xs text-danger-600">{t('unreachable')}</p> : null}
    {changed ? <Button size="sm" color="primary" className="w-full" onPress={() => window.location.reload()}>{t('reload')}</Button> : available ? <Button size="sm" color="primary" className="w-full" isDisabled={busy || unreachable} startContent={<Download size={14} />} onPress={() => void command('apply', { version: data.latest })}>{t('install')}</Button> : null}
    {available && !busy ? <p className="text-xs leading-relaxed text-[var(--polaris-ink-3)]">{t('restartHint')}</p> : null}
  </div>;
}
