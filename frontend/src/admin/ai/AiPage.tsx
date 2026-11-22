import { ApiError } from '@/api/errors';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { AiHistory } from '@/components/ai/AiHistory';
import { Drawer, Modal } from '@/components/ui/MotionOverlays';
import { toast } from '@/components/ui/toast';
import { Button, DrawerBody, DrawerContent, DrawerHeader, ModalBody, ModalContent, ModalFooter, ModalHeader, Skeleton } from '@heroui/react';
import { ArrowLeft, Bot, Download, Plus, RefreshCw, Settings2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useTranslations } from 'use-intl';
import type { AiChannel, AiModel } from '../../../../shared/ai-management';
import { EmptyState } from '../components/ConsolePrimitives';
import { AdminPage } from '../layout/AdminPage';
import { updatePresentation, usePresentation } from '../settings/presentation-api';
import { useConsoleRefreshInterval } from '../useConsoleData';
import { AiChannelList, ChannelSummary } from './AiChannels';
import { ChannelEditor, ModelEditor } from './AiEditors';
import { ImportModels } from './AiImport';
import { AiModelList } from './AiModels';
import { AiOverview } from './AiOverview';
import { aiApi, useAiData } from './api';
import { BULK_PATCH, bulkTargets, manualResult, modelUpdate, type AiBucket, type AiBulkOp, type AiSort, type ManualResults } from './presentation';
import { useAiError } from './useAiError';

type Confirmation =
  | { kind: 'paid'; model: AiModel; channel: AiChannel }
  | { kind: 'channels'; channel: AiChannel; modelCount: number }
  | { kind: 'models'; model: AiModel }
  | { kind: 'bulkDelete'; models: AiModel[] };

const SORT_KEY = 'uptime-polaris.ai.sort';

function storedSort(): AiSort {
  try {
    const value = localStorage.getItem(SORT_KEY);
    return value === 'status' || value === 'name' || value === 'availability' || value === 'latency' ? value : 'created';
  } catch {
    return 'created';
  }
}

export function AiPage() {
  const t = useTranslations('admin.ai');
  const action = useTranslations('admin.action');
  const describe = useAiError();
  const navigate = useNavigate();
  const [search, setSearch] = useSearchParams();
  const { channelId } = useParams<{ channelId: string }>();
  const interval = useConsoleRefreshInterval();
  const feature = usePresentation();
  const enabled = feature.data?.config.aiEnabled === true;
  const resource = useAiData(enabled, interval);
  const revoked = resource.error instanceof ApiError && [401, 403, 404].includes(resource.error.status);
  const data = revoked ? undefined : resource.data;
  const unavailable = Boolean(resource.error);
  const channel = channelId ? data?.channels.find((item) => item.id === channelId) : undefined;
  const channelModels = useMemo(() => data?.models.filter((item) => item.channelId === channelId) ?? [], [data, channelId]);

  const [filter, setFilter] = useState<AiBucket | null>(null);
  const [query, setQuery] = useState('');
  const [sort, setSortState] = useState<AiSort>(storedSort);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkProgress, setBulkProgress] = useState<{ done: number; total: number } | null>(null);
  const [editingChannel, setEditingChannel] = useState<AiChannel | null | undefined>();
  const [editingModel, setEditingModel] = useState<AiModel | null | undefined>();
  const [template, setTemplate] = useState<AiModel | undefined>();
  const [importing, setImporting] = useState(false);
  const [historyId, setHistoryId] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const inFlight = useRef(false);
  const [operationError, setOperationError] = useState('');
  const [results, setResults] = useState<ManualResults>({});
  const [focusId, setFocusId] = useState<string | null>(null);

  const setSort = (value: AiSort) => {
    setSortState(value);
    try {
      localStorage.setItem(SORT_KEY, value);
    } catch {
      /* Private mode: the choice lasts for this visit. / 隐私模式下仅在本次访问内生效。 */
    }
  };

  // Filters and selection belong to the view they were set on. / 筛选和选择只属于设置它们的视图。
  useEffect(() => {
    setFilter(null);
    setQuery('');
    setSelected(new Set());
  }, [channelId]);

  // Drop selected models that no longer exist. / 移除已不存在的选中模型。
  useEffect(() => {
    setSelected((previous) => {
      if (!previous.size) return previous;
      const next = new Set([...previous].filter((id) => channelModels.some((model) => model.id === id)));
      return next.size === previous.size ? previous : next;
    });
  }, [channelModels]);

  // `?model=` comes from the command palette: point at that row once. / `?model=` 来自命令面板，只定位一次对应行。
  const requested = search.get('model');
  useEffect(() => {
    if (!requested) return;
    setFocusId(requested);
    const next = new URLSearchParams(search);
    next.delete('model');
    setSearch(next, { replace: true });
  }, [requested, search, setSearch]);
  // Start the fade once the rows exist, so a slow load does not swallow it. / 行出现后再开始计时，避免加载慢时高亮提前消失。
  const loaded = data !== undefined;
  useEffect(() => {
    if (!focusId || !loaded) return;
    const timer = window.setTimeout(() => setFocusId(null), 2600);
    return () => window.clearTimeout(timer);
  }, [focusId, loaded]);

  const refresh = () => {
    void resource.mutate().catch(() => undefined);
  };
  const replaceModel = (saved: AiModel) =>
    resource.mutate(
      (previous) => previous && { ...previous, models: [...previous.models.filter((item) => item.id !== saved.id), saved] },
      { revalidate: false },
    );

  const savedChannel = (saved: AiChannel) => {
    const created = !editingChannel;
    setEditingChannel(undefined);
    void resource
      .mutate((previous) => previous && { ...previous, channels: [...previous.channels.filter((item) => item.id !== saved.id), saved] }, { revalidate: true })
      .catch(() => undefined);
    toast.success(t('saved'));
    if (created) navigate(`/admin/ai/${encodeURIComponent(saved.id)}`);
  };
  const savedModel = (saved: AiModel) => {
    setEditingModel(undefined);
    setTemplate(undefined);
    void replaceModel(saved).then(refresh, () => undefined);
    setFocusId(saved.id);
    toast.success(t('saved'));
  };
  const imported = (added: AiModel[]) => {
    void resource
      .mutate((previous) => previous && { ...previous, models: [...previous.models.filter((item) => !added.some((model) => model.id === item.id)), ...added] }, { revalidate: true })
      .catch(() => undefined);
    if (added.length) toast.success(t('importDone', { count: added.length }));
  };

  const run = async (key: string, task: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(key);
    setOperationError('');
    try {
      await task();
    } catch (error) {
      setOperationError(describe(error));
      if (error instanceof ApiError && error.code === 'revision_conflict') refresh();
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  const testChannel = (target: AiChannel) =>
    void run(`channel:${target.id}`, async () => {
      const { result } = await aiApi.testChannel(target);
      setResults((previous) => ({ ...previous, [`channel:${target.id}`]: result }));
    });

  const patchModel = (model: AiModel, patch: Partial<Pick<AiModel, 'enabled' | 'isPublic'>>, message: string) =>
    void run(`model:${model.id}`, async () => {
      const { model: saved } = await aiApi.updateModel(model.id, modelUpdate(model, patch));
      await replaceModel(saved);
      toast.success(message);
    });

  /** One request per model, so a conflict on one does not undo the rest. / 每个模型单独请求，一个冲突不会影响其余模型。 */
  const runBulk = (op: AiBulkOp, models: AiModel[]) =>
    run('bulk', async () => {
      const targets = bulkTargets(models, op);
      const failed: string[] = [];
      setBulkProgress({ done: 0, total: targets.length });
      for (const [index, model] of targets.entries()) {
        try {
          if (op === 'delete') await aiApi.remove('models', model.id, model.revision);
          else await replaceModel((await aiApi.updateModel(model.id, modelUpdate(model, BULK_PATCH[op]))).model);
        } catch {
          failed.push(model.name);
        }
        setBulkProgress({ done: index + 1, total: targets.length });
      }
      setBulkProgress(null);
      if (op === 'delete') {
        const removed = targets.filter((model) => !failed.includes(model.name)).map((model) => model.id);
        await resource.mutate((previous) => previous && { ...previous, models: previous.models.filter((model) => !removed.includes(model.id)) }, { revalidate: false });
      }
      setSelected(new Set(targets.filter((model) => failed.includes(model.name)).map((model) => model.id)));
      refresh();
      const done = targets.length - failed.length;
      if (failed.length) setOperationError(t('bulkPartial', { done, failed: failed.length, names: failed.slice(0, 3).join('、') }));
      else toast.success(t('bulkDone', { count: done }));
    });

  const bulk = (op: AiBulkOp, models: AiModel[]) => {
    if (op === 'delete') openConfirm({ kind: 'bulkDelete', models });
    else void runBulk(op, models);
  };

  const confirm = () => {
    if (!confirmation) return;
    if (confirmation.kind === 'bulkDelete') {
      const models = confirmation.models;
      setConfirmation(null);
      void runBulk('delete', models);
      return;
    }
    void run('confirm', async () => {
      if (confirmation.kind === 'paid') {
        const { result } = await aiApi.checkModel(confirmation.model, confirmation.channel);
        setResults((previous) => ({ ...previous, [`model:${confirmation.model.id}`]: result }));
      } else {
        const target = confirmation.kind === 'channels' ? confirmation.channel : confirmation.model;
        await aiApi.remove(confirmation.kind, target.id, target.revision);
        await resource.mutate(
          (previous) =>
            !previous
              ? previous
              : confirmation.kind === 'channels'
                ? { channels: previous.channels.filter((item) => item.id !== target.id), models: previous.models.filter((item) => item.channelId !== target.id) }
                : { ...previous, models: previous.models.filter((item) => item.id !== target.id) },
          { revalidate: false },
        );
        if (confirmation.kind === 'channels' && channelId === target.id) navigate('/admin/ai');
        refresh();
        toast.success(t('deleted'));
      }
      setConfirmation(null);
    });
  };
  function openConfirm(value: Confirmation) {
    setOperationError('');
    setConfirmation(value);
  }

  const controlsDisabled = busy !== null;
  const historyModel = data?.models.find((model) => model.id === historyId);
  const historyChannel = historyModel ? data?.channels.find((item) => item.id === historyModel.channelId) : undefined;
  const editorChannel = channel ?? (template ? data?.channels.find((item) => item.id === template.channelId) : undefined);

  if (!enabled) return <AiDisabled loading={!feature.data && !feature.error} error={feature.error} />;

  const actions = (
    <>
      <Button
        size="sm"
        variant="bordered"
        className="border-[var(--polaris-line-strong)] bg-[var(--polaris-card)]"
        isLoading={resource.isValidating}
        onPress={refresh}
        startContent={resource.isValidating ? null : <RefreshCw size={14} />}
      >
        {t('refresh')}
      </Button>
      {channel ? (
        <>
          <Button size="sm" variant="bordered" className="border-[var(--polaris-line-strong)] bg-[var(--polaris-card)]" startContent={<Download size={14} />} onPress={() => setImporting(true)}>
            {t('importModels')}
          </Button>
          <Button color="primary" size="sm" startContent={<Plus size={15} />} onPress={() => setEditingModel(null)}>
            {t('addModel')}
          </Button>
        </>
      ) : !channelId ? (
        <Button color="primary" size="sm" startContent={<Plus size={15} />} onPress={() => setEditingChannel(null)}>
          {t('addChannel')}
        </Button>
      ) : null}
    </>
  );

  const scopeModels = channel ? channelModels : (data?.models ?? []);
  const confirmTitle = confirmation?.kind === 'paid' ? t('confirmCheck') : confirmation?.kind === 'bulkDelete' ? t('confirmBulkDelete', { count: confirmation.models.length }) : t('confirmDelete');

  return (
    <AdminPage
      title={channel?.name ?? t('title')}
      description={channel ? undefined : t('description')}
      back={channelId ? { href: '/admin/ai', label: t('back') } : undefined}
      actions={actions}
    >
      <div className="flex min-h-0 flex-1 flex-col gap-5">
        {resource.error && !revoked ? (
          <div role="alert" className="flex items-center gap-3 rounded-xl border border-danger/20 bg-danger/[0.04] px-4 py-2.5 text-[13px] text-danger-600">
            <span className="min-w-0 flex-1">{describe(resource.error)}</span>
            <Button size="sm" variant="light" color="danger" onPress={refresh}>
              {action('retry')}
            </Button>
          </div>
        ) : null}
        {operationError && !confirmation ? (
          <p role="alert" className="rounded-xl border border-danger/20 bg-danger/[0.04] px-4 py-2.5 text-[13px] text-danger-600">
            {operationError}
          </p>
        ) : null}

        {!data ? (
          resource.error ? null : <LoadingState />
        ) : channelId && !channel ? (
          <EmptyState
            title={t('channelMissing')}
            action={
              <Button as={Link} to="/admin/ai" size="sm" variant="bordered" startContent={<ArrowLeft size={15} />}>
                {t('back')}
              </Button>
            }
          />
        ) : (
          <>
            {channel ? (
              <ChannelSummary
                channel={channel}
                result={manualResult(results, 'channel', channel.id, channel.revision, channel.revision)}
                busy={busy}
                onTest={() => testChannel(channel)}
                onEdit={() => setEditingChannel(channel)}
                onDelete={() => openConfirm({ kind: 'channels', channel, modelCount: channelModels.length })}
              />
            ) : null}
            <AiOverview models={scopeModels} channels={channel ? null : data.channels.length} unavailable={unavailable} filter={filter} onFilter={setFilter} />
            {channel ? (
              <AiModelList
                channel={channel}
                models={channelModels}
                unavailable={unavailable}
                filter={filter}
                onFilter={setFilter}
                query={query}
                onQuery={setQuery}
                sort={sort}
                onSort={setSort}
                selected={selected}
                onSelect={(ids, on) =>
                  setSelected((previous) => {
                    const next = new Set(previous);
                    for (const id of ids) on ? next.add(id) : next.delete(id);
                    return next;
                  })
                }
                onBulk={bulk}
                bulkProgress={bulkProgress}
                refreshInterval={interval}
                results={results}
                busy={busy}
                focusId={focusId}
                onAdd={() => setEditingModel(null)}
                onImport={() => setImporting(true)}
                onHistory={(model) => setHistoryId(model.id)}
                onCheck={(model) => openConfirm({ kind: 'paid', model, channel })}
                onEdit={(model) => setEditingModel(model)}
                onDuplicate={(model) => {
                  setTemplate(model);
                  setEditingModel(null);
                }}
                onToggle={(model) => patchModel(model, { enabled: !model.enabled }, t(model.enabled ? 'pausedToast' : 'resumedToast'))}
                onTogglePublic={(model) => patchModel(model, { isPublic: !model.isPublic }, t(model.isPublic ? 'privateToast' : 'publicToast'))}
                onDelete={(model) => openConfirm({ kind: 'models', model })}
              />
            ) : (
              <AiChannelList
                channels={data.channels}
                models={data.models}
                unavailable={unavailable}
                filter={filter}
                onFilter={setFilter}
                query={query}
                onQuery={setQuery}
                refreshInterval={interval}
                results={results}
                busy={busy}
                onAdd={() => setEditingChannel(null)}
                onTest={testChannel}
                onEdit={(item) => setEditingChannel(item)}
                onDelete={(item) => openConfirm({ kind: 'channels', channel: item, modelCount: data.models.filter((model) => model.channelId === item.id).length })}
              />
            )}
          </>
        )}
      </div>

      {!revoked && editingChannel !== undefined ? (
        <ChannelEditor channel={editingChannel} onClose={() => setEditingChannel(undefined)} onSaved={savedChannel} />
      ) : null}
      {!revoked && editingModel !== undefined && editorChannel ? (
        <ModelEditor
          channel={editorChannel}
          model={editingModel}
          template={template}
          onClose={() => {
            setEditingModel(undefined);
            setTemplate(undefined);
          }}
          onSaved={savedModel}
        />
      ) : null}
      {!revoked && importing && channel ? (
        <ImportModels
          channel={channel}
          existing={channelModels}
          onClose={() => setImporting(false)}
          onAdded={imported}
        />
      ) : null}
      {!revoked && historyModel ? (
        <Drawer isOpen placement="right" size="2xl" onClose={() => setHistoryId(null)} scrollBehavior="inside" classNames={{ base: 'bg-[var(--polaris-canvas)]' }}>
          <DrawerContent>
            <DrawerHeader className="flex flex-col gap-0.5 border-b border-[var(--polaris-line)] pr-12">
              <span className="truncate text-[15px] font-semibold">{historyModel.name}</span>
              <span className="flex min-w-0 items-center gap-1.5 text-[12px] font-normal text-[var(--polaris-ink-3)]">
                {historyChannel ? <span className="truncate">{historyChannel.name}</span> : null}
                {historyChannel ? <span aria-hidden="true">·</span> : null}
                <span className="truncate font-mono">{historyModel.modelId}</span>
              </span>
            </DrawerHeader>
            <DrawerBody className="py-6">
              <AiHistory recent={historyModel.recent} url={(days) => `/api/admin/ai/models/${encodeURIComponent(historyModel.id)}/history?days=${days}`} />
            </DrawerBody>
          </DrawerContent>
        </Drawer>
      ) : null}
      {!revoked && confirmation ? (
        <Modal isOpen size="md" isDismissable={!controlsDisabled} isKeyboardDismissDisabled={controlsDisabled} onClose={() => !controlsDisabled && setConfirmation(null)}>
          <ModalContent>
            <ModalHeader>{confirmTitle}</ModalHeader>
            <ModalBody>
              {confirmation.kind === 'bulkDelete' ? (
                <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto text-small">
                  {confirmation.models.map((model) => (
                    <li key={model.id} className="flex min-w-0 items-baseline gap-2">
                      <span className="truncate font-medium">{model.name}</span>
                      <span className="truncate font-mono text-[12px] text-[var(--polaris-ink-3)]">{model.modelId}</span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="break-words text-small font-medium">{confirmation.kind === 'channels' ? confirmation.channel.name : confirmation.model.name}</p>
              )}
              {confirmation.kind === 'paid' ? <p className="break-all font-mono text-[12px] text-[var(--polaris-ink-3)]">{confirmation.model.modelId}</p> : null}
              <p className="text-small text-[var(--polaris-ink-3)]">
                {confirmation.kind === 'paid'
                  ? t('paidHint')
                  : confirmation.kind === 'channels'
                    ? t('deleteChannelHint', { count: confirmation.modelCount })
                    : confirmation.kind === 'bulkDelete'
                      ? t('deleteBulkHint')
                      : t('deleteModelHint')}
              </p>
              {operationError ? (
                <p role="alert" className="text-small text-danger">
                  {operationError}
                </p>
              ) : null}
            </ModalBody>
            <ModalFooter>
              <Button variant="light" isDisabled={controlsDisabled} onPress={() => setConfirmation(null)}>
                {action('cancel')}
              </Button>
              <Button color={confirmation.kind === 'paid' ? 'primary' : 'danger'} isLoading={busy === 'confirm'} onPress={confirm}>
                {confirmation.kind === 'paid' ? t('confirmPaid') : action('delete')}
              </Button>
            </ModalFooter>
          </ModalContent>
        </Modal>
      ) : null}
    </AdminPage>
  );
}

function LoadingState() {
  return (
    <div className="flex flex-col gap-5" role="status" aria-busy="true">
      <Skeleton className="h-[92px] rounded-xl" />
      <div className="polaris-card flex flex-col gap-2 p-4">
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className="h-14 rounded-lg" />
        ))}
      </div>
    </div>
  );
}

/** Off by default: say what the feature does and switch it on in place. / 默认关闭：说明功能用途，并可在此直接启用。 */
function AiDisabled({ loading, error }: { loading: boolean; error: unknown }) {
  const t = useTranslations('admin.ai');
  const describe = useApiErrorMessage();
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState('');
  const enable = async () => {
    if (saving) return;
    setSaving(true);
    setSaveError('');
    try {
      await updatePresentation((config) => ({ ...config, aiEnabled: true }));
    } catch (reason) {
      setSaveError(describe(reason));
    } finally {
      setSaving(false);
    }
  };
  return (
    <AdminPage title={t('title')} description={t('description')}>
      <section className="polaris-card mx-auto flex w-full max-w-xl flex-col items-center px-6 py-12 text-center">
        <span className="mb-5 inline-flex h-12 w-12 items-center justify-center rounded-2xl border border-[var(--polaris-line)] bg-[var(--polaris-card)] text-[var(--polaris-ink-2)] shadow-[0_1px_1px_rgb(0_0_0/0.04)]">
          <Bot size={22} aria-hidden="true" />
        </span>
        <h2 className="text-[15px] font-semibold text-[var(--polaris-ink)]">{t('featureDisabled')}</h2>
        <p className="mt-2 max-w-md text-[13px] leading-relaxed text-[var(--polaris-ink-3)]">{t('disabledIntro')}</p>
        <ul className="mt-5 flex w-full max-w-md flex-col gap-2 text-left text-[13px] text-[var(--polaris-ink-2)]">
          {(['disabledPoint1', 'disabledPoint2', 'disabledPoint3'] as const).map((key) => (
            <li key={key} className="flex gap-2.5 rounded-lg bg-[var(--polaris-well)] px-3 py-2">
              <span aria-hidden="true" className="mt-[7px] h-1.5 w-1.5 shrink-0 rounded-full bg-[var(--polaris-ink-4)]" />
              {t(key)}
            </li>
          ))}
        </ul>
        {loading ? (
          <p role="status" className="mt-6 text-small text-[var(--polaris-ink-3)]">
            {t('loading')}
          </p>
        ) : error ? (
          <p role="alert" className="mt-6 text-small text-danger">
            {describe(error)}
          </p>
        ) : (
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Button color="primary" isLoading={saving} onPress={() => void enable()}>
              {t('featureEnabled')}
            </Button>
            <Button as={Link} to="/admin/settings#settings-presentation" variant="bordered" startContent={<Settings2 size={15} />}>
              {t('openSettings')}
            </Button>
          </div>
        )}
        {saveError ? (
          <p role="alert" className="mt-3 text-small text-danger">
            {saveError}
          </p>
        ) : null}
      </section>
    </AdminPage>
  );
}
