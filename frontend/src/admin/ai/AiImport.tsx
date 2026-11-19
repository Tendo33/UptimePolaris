import { ApiError } from '@/api/errors';
import { Drawer } from '@/components/ui/MotionOverlays';
import { Button, Checkbox, DrawerBody, DrawerContent, DrawerFooter, DrawerHeader, Input, Switch } from '@heroui/react';
import clsx from 'clsx';
import { RefreshCw, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { useFormatter, useTranslations } from 'use-intl';
import type { AiChannel, AiModel } from '../../../../shared/ai-management';
import { DEFAULT_AI_REQUEST } from '../../../../shared/ai-request';
import { ProtocolChip } from './AiParts';
import { aiApi, useRemoteModels } from './api';
import { useAiError } from './useAiError';

const INTERVALS = [60, 300, 900, 1800, 3600];

/** Why the list could not be read, with the upstream outcome when the server says it. / 无法读取列表的原因；服务端提供上游结果时一并说明。 */
function useRemoteError() {
  const t = useTranslations('admin.ai');
  const describe = useAiError();
  return (error: unknown) => {
    if (error instanceof ApiError && error.code === 'ai_models_unavailable') {
      const outcome = typeof error.details?.outcome === 'string' ? error.details.outcome : '';
      return outcome && t.has(`outcomes.${outcome}`) ? `${t('errors.ai_models_unavailable')} ${t(`outcomes.${outcome}`)}` : t('errors.ai_models_unavailable');
    }
    if (error instanceof ApiError && error.status === 404 && error.code === 'not_found') return t('remoteUnsupported');
    return describe(error);
  };
}

/**
 * Pick several of the channel's models and add them with shared settings, one
 * request each, so a failure names the model it belongs to.
 *
 * 从渠道模型中选择多个，以相同设置逐个添加；单个失败时可明确指出是哪个模型。
 */
export function ImportModels({ channel, existing, onClose, onAdded }: { channel: AiChannel; existing: AiModel[]; onClose: () => void; onAdded: (added: AiModel[]) => void }) {
  const t = useTranslations('admin.ai');
  const action = useTranslations('admin.action');
  const format = useFormatter();
  const describe = useAiError();
  const remoteError = useRemoteError();
  const remote = useRemoteModels(channel, true);
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [interval, setIntervalSec] = useState(300);
  const [enabled, setEnabled] = useState(true);
  const [isPublic, setIsPublic] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [failures, setFailures] = useState<Array<{ id: string; reason: string }>>([]);
  const running = useRef(false);

  const taken = useMemo(() => new Set(existing.map((model) => model.modelId)), [existing]);
  const needle = query.trim().toLowerCase();
  const list = (remote.data?.models ?? []).filter((item) => !needle || `${item.id}\n${item.name ?? ''}`.toLowerCase().includes(needle));
  const available = list.filter((item) => !taken.has(item.id));
  const allPicked = available.length > 0 && available.every((item) => picked.has(item.id));
  const busy = progress !== null;
  const daily = Math.ceil(86400 / interval) * picked.size;

  const toggle = (ids: string[], on: boolean) =>
    setPicked((previous) => {
      const next = new Set(previous);
      for (const id of ids) on ? next.add(id) : next.delete(id);
      return next;
    });

  const submit = async () => {
    if (running.current || !picked.size) return;
    running.current = true;
    const ids = [...picked];
    const added: AiModel[] = [];
    const failed: Array<{ id: string; reason: string }> = [];
    setFailures([]);
    setProgress({ done: 0, total: ids.length });
    const names = new Map((remote.data?.models ?? []).map((item) => [item.id, item.name]));
    for (const [index, id] of ids.entries()) {
      try {
        const { model } = await aiApi.createModel({
          channelId: channel.id,
          name: names.get(id) || id,
          modelId: id,
          intervalSec: interval,
          timeoutMs: Math.min(30_000, (interval - 1) * 1000),
          enabled,
          isPublic,
          request: DEFAULT_AI_REQUEST,
        });
        added.push(model);
      } catch (error) {
        failed.push({ id, reason: describe(error) });
      }
      setProgress({ done: index + 1, total: ids.length });
    }
    running.current = false;
    setProgress(null);
    if (added.length) onAdded(added);
    if (failed.length) {
      // Stay open so the failures can be read and retried. / 保持打开，以便查看失败原因并重试。
      setFailures(failed);
      setPicked(new Set(failed.map((item) => item.id)));
      return;
    }
    onClose();
  };

  return (
    <Drawer isOpen placement="right" size="lg" scrollBehavior="inside" isDismissable={!busy} isKeyboardDismissDisabled={busy} onClose={() => !busy && onClose()} classNames={{ base: 'bg-[var(--polaris-canvas)]' }}>
      <DrawerContent>
        <DrawerHeader className="flex flex-col gap-0.5 border-b border-[var(--polaris-line)] pr-12">
          <span className="text-[14px] font-semibold">{t('importModels')}</span>
          <span className="flex min-w-0 items-center gap-2 text-[12px] font-normal text-[var(--polaris-ink-3)]">
            <span className="truncate">{channel.name}</span>
            <ProtocolChip protocol={channel.protocol} />
          </span>
        </DrawerHeader>
        <DrawerBody className="flex flex-col gap-5 py-5">
          <p className="text-[12.5px] leading-5 text-[var(--polaris-ink-3)]">{t('importHint')}</p>

          {remote.error ? (
            <div role="alert" className="flex flex-wrap items-center gap-2 rounded-xl border border-danger/20 bg-danger/[0.04] px-3.5 py-2.5 text-[13px] text-danger-600">
              <p className="min-w-0 flex-1">{remoteError(remote.error)}</p>
              <Button size="sm" variant="light" color="danger" startContent={<RefreshCw size={13} />} onPress={() => void remote.mutate().catch(() => undefined)}>
                {action('retry')}
              </Button>
            </div>
          ) : null}

          {remote.isLoading ? (
            <div role="status" aria-busy="true" className="flex flex-col gap-2">
              {[0, 1, 2, 3, 4].map((index) => (
                <span key={index} className="polaris-shimmer h-10 rounded-lg" />
              ))}
              <span className="sr-only">{t('remoteLoading')}</span>
            </div>
          ) : remote.data ? (
            <section className="flex min-h-0 flex-col gap-2">
              <div className="flex items-center gap-2">
                <Input
                  size="sm"
                  aria-label={t('searchRemote')}
                  placeholder={t('searchRemote')}
                  value={query}
                  onValueChange={setQuery}
                  startContent={<Search size={14} className="shrink-0 text-[var(--polaris-ink-4)]" />}
                  isDisabled={busy}
                />
                <Button size="sm" isIconOnly variant="light" aria-label={t('refresh')} isDisabled={busy} isLoading={remote.isValidating} onPress={() => void remote.mutate().catch(() => undefined)}>
                  <RefreshCw size={14} />
                </Button>
              </div>
              <div className="flex items-center justify-between gap-3 px-1 text-[12px] text-[var(--polaris-ink-3)]">
                <Checkbox size="sm" isSelected={allPicked} isIndeterminate={!allPicked && available.some((item) => picked.has(item.id))} isDisabled={busy || available.length === 0} onValueChange={(on) => toggle(available.map((item) => item.id), on)}>
                  <span className="text-[12px]">{t('pickAll')}</span>
                </Checkbox>
                <span className="polaris-num">{t('remoteCount', { shown: list.length, total: remote.data.models.length })}</span>
              </div>
              {list.length ? (
                <ul className="max-h-[22rem] divide-y divide-[var(--polaris-line-soft)] overflow-y-auto rounded-xl border border-[var(--polaris-line)] bg-[var(--polaris-card)]">
                  {list.map((item) => {
                    const exists = taken.has(item.id);
                    const failure = failures.find((entry) => entry.id === item.id);
                    return (
                      <li key={item.id} className={clsx('flex items-center gap-3 px-3 py-2', exists && 'opacity-60')}>
                        <Checkbox size="sm" aria-label={item.id} isSelected={exists || picked.has(item.id)} isDisabled={exists || busy} onValueChange={(on) => toggle([item.id], on)} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate font-mono text-[12.5px] text-[var(--polaris-ink)]" title={item.id}>
                            {item.id}
                          </p>
                          {item.name && item.name !== item.id ? <p className="truncate text-[12px] text-[var(--polaris-ink-3)]">{item.name}</p> : null}
                          {failure ? <p className="text-[12px] text-danger-600">{failure.reason}</p> : null}
                        </div>
                        {exists ? <span className="shrink-0 text-[11.5px] text-[var(--polaris-ink-3)]">{t('alreadyAdded')}</span> : null}
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="rounded-xl border border-dashed border-[var(--polaris-line)] px-4 py-8 text-center text-[13px] text-[var(--polaris-ink-3)]">{t(remote.data.models.length ? 'noMatch' : 'remoteEmpty')}</p>
              )}
            </section>
          ) : null}

          <section className="flex flex-col gap-3 border-t border-[var(--polaris-line-soft)] pt-5">
            <h3 className="text-[13px] font-semibold text-[var(--polaris-ink)]">{t('importSettings')}</h3>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label={t('intervalPresets')}>
              {INTERVALS.map((seconds) => (
                <button
                  key={seconds}
                  type="button"
                  disabled={busy}
                  aria-pressed={interval === seconds}
                  onClick={() => setIntervalSec(seconds)}
                  className={clsx(
                    'h-7 rounded-lg border px-2.5 text-[12px] font-medium transition-colors disabled:opacity-60',
                    interval === seconds ? 'border-[var(--polaris-ink)] bg-[var(--polaris-ink)] text-[var(--polaris-canvas)]' : 'border-[var(--polaris-line)] bg-[var(--polaris-card)] text-[var(--polaris-ink-2)] hover:border-[var(--polaris-line-strong)]',
                  )}
                >
                  {seconds % 3600 === 0 ? t('presetHours', { n: seconds / 3600 }) : t('presetMinutes', { n: seconds / 60 })}
                </button>
              ))}
            </div>
            <Switch size="sm" isSelected={enabled} isDisabled={busy} onValueChange={setEnabled}>
              {t('enabled')}
            </Switch>
            <Switch size="sm" isSelected={isPublic} isDisabled={busy} onValueChange={setIsPublic}>
              {t('makePublic')}
            </Switch>
            {picked.size ? (
              <p className="rounded-xl bg-[var(--polaris-well)] px-3.5 py-2.5 text-[12.5px] leading-5 text-[var(--polaris-ink-2)]">
                {t('importEstimate', { count: picked.size, daily: format.number(daily) })}
              </p>
            ) : null}
            {failures.length ? (
              <p role="alert" className="text-[12.5px] text-danger-600">
                {t('importFailed', { count: failures.length })}
              </p>
            ) : null}
          </section>
        </DrawerBody>
        <DrawerFooter className="border-t border-[var(--polaris-line)]">
          <Button variant="light" isDisabled={busy} onPress={onClose}>
            {action('cancel')}
          </Button>
          <Button color="primary" isDisabled={!picked.size} isLoading={busy} onPress={() => void submit()}>
            {progress ? t('bulkProgress', { done: progress.done, total: progress.total }) : t('importSubmit', { count: picked.size })}
          </Button>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
