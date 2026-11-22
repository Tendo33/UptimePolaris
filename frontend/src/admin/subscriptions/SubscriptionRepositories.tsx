import { Modal } from '@/components/ui/MotionOverlays';
import { Button, Input, ModalBody, ModalContent, ModalFooter, ModalHeader } from '@heroui/react';
import { Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import type { SubscriptionRepository } from '../../../../shared/subscriptions';
import { OFFICIAL_SUBSCRIPTION_ROOT } from '../../../../shared/subscription-templates';
import { subscriptionsApi } from './api';
import { Failure, Timestamp } from './Parts';

export function SubscriptionRepositories({ repositories, onChanged, onClose }: { repositories: SubscriptionRepository[]; onChanged: () => Promise<void>; onClose: () => void }) {
  const t = useTranslations('admin.subscriptions');
  const [name, setName] = useState(''), [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const lock = useRef(false);
  const act = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(undefined);
    try { await work(); await onChanged(); } catch (cause) { setError(cause); } finally { lock.current = false; setBusy(false); }
  };
  return (
    <Modal isOpen size="3xl" scrollBehavior="inside" isDismissable={!busy} isKeyboardDismissDisabled={busy} onClose={() => { if (!busy) onClose(); }} classNames={{ base: 'bg-[var(--polaris-card)] text-[var(--polaris-ink)]' }}>
      <ModalContent>
        <ModalHeader className="border-b border-[var(--polaris-line)] pr-12">{t('manageRepositories')}</ModalHeader>
        <ModalBody className="gap-4 py-5">
          <p className="text-[13px] text-[var(--polaris-ink-3)]">{t('repositoryHint')}</p>
          <Failure error={error} />
          <ul className="divide-y divide-[var(--polaris-line)]">
            <li className="flex items-center gap-3 py-3">
              <div className="min-w-0 flex-1">
                <p className="text-[13px] font-medium">{t('officialRepository')}</p>
                <a href={`${OFFICIAL_SUBSCRIPTION_ROOT}catalog.json`} target="_blank" rel="noreferrer" className="block truncate text-[12px] text-[var(--polaris-ink-3)] underline-offset-4 hover:underline">{OFFICIAL_SUBSCRIPTION_ROOT}catalog.json</a>
              </div>
              <span className="text-[12px] text-[var(--polaris-ink-3)]">{t('official')}</span>
            </li>
            {repositories.map(repository => (
              <li key={repository.id} className="flex flex-wrap items-center gap-3 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{repository.name}</p>
                  <a href={repository.url} target="_blank" rel="noreferrer" className="block truncate text-[12px] text-[var(--polaris-ink-3)] underline-offset-4 hover:underline">{repository.url}</a>
                  <p className="mt-1 text-[12px] text-[var(--polaris-ink-3)]">{repository.stale ? t('repositoryStale') : <Timestamp value={repository.fetchedAt} />}</p>
                </div>
                <Button size="sm" variant="light" color="danger" isDisabled={busy} aria-label={t('removeRepositoryNamed', { name: repository.name })} startContent={<Trash2 size={14} />} onPress={() => { if (window.confirm(t('removeRepositoryHint'))) void act(() => subscriptionsApi.removeRepository(repository.id).then(() => undefined)); }}>{t('removeRepository')}</Button>
              </li>
            ))}
          </ul>
          <form className="grid items-end gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]" onSubmit={event => { event.preventDefault(); void act(async () => { await subscriptionsApi.addRepository({ name: name.trim(), url: url.trim() }); setName(''); setUrl(''); }); }}>
            <Input label={t('repositoryName')} labelPlacement="outside" value={name} onValueChange={setName} isRequired maxLength={120} isDisabled={busy} />
            <Input label={t('repositoryUrl')} labelPlacement="outside" type="url" value={url} onValueChange={setUrl} isRequired maxLength={2048} isDisabled={busy} placeholder="https://…/catalog.json" />
            <Button type="submit" color="primary" isLoading={busy} isDisabled={repositories.length >= 8 || !name.trim() || !url.trim()} startContent={busy ? undefined : <Plus size={15} />}>{t('addRepository')}</Button>
          </form>
        </ModalBody>
        <ModalFooter className="border-t border-[var(--polaris-line)]"><Button variant="light" isDisabled={busy} onPress={onClose}>{t('close')}</Button></ModalFooter>
      </ModalContent>
    </Modal>
  );
}
