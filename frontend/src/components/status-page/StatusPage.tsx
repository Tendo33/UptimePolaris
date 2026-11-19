
import { usePageConfig } from '@/components/context/PageConfigContext';
import { usePresentationView } from '@/components/context/PresentationViewContext';
import { GroupSection, GroupSkeleton, type PageGroup } from '@/components/status-page/GroupSection';
import { filterMonitorByStatus } from '@/components/status-page/monitor-filters';
import { useMonitorFilters } from '@/components/status-page/MonitorFilterContext';
import { StatusHero } from '@/components/status-page/StatusHero';
import { Toolbar, type ViewMode } from '@/components/status-page/Toolbar';
import { useRefreshTimer } from '@/components/status-page/useRefreshTimer';
import { revalidateData, SWR_KEYS, useConfig, useMonitorData, usePublicAiModels } from '@/components/status-page/useStatusPageData';
import { AiModels, filterAiModels } from './AiModels';
import { aiStatusKey } from '@/components/ai/status';
import { ApiError } from '@/api/errors';
import { filterSubscriptions, PublicSubscriptions, subscriptionBucket, usePublicSubscriptions } from '../subscriptions/PublicSubscriptions';
import { calculateMonitorStatusCounts, selectSystemStatus } from '@/lib/monitor-status';
import { CONTENT_TRANSITION, MOTION_EASE } from '@/lib/motion';
import type { Monitor } from '@/types/monitor';
import { AnimatePresence, motion } from 'framer-motion';
import { CloudOff, SearchX } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'use-intl';

const VIEW_KEY = 'uptime-polaris.status.view';

/**
 * The public status page.
 *
 * One sentence about the whole system at the top, then any notices, then the
 * groups - each a list of monitors with their recent checks and the day's
 * availability. Search and the status filter live in one row above the groups
 * and stay pinned under the header while the visitor scrolls.
 *
 * 公开状态页顶部用一句话概括系统，之后依次展示通知和监控分组；每组列出监控项、
 * 近期检查和当日可用率。搜索及状态筛选位于分组上方同一行，滚动时固定在页头下方。
 */
export function StatusPage({ aiOnly = false }: { aiOnly?: boolean }) {
  const t = useTranslations();
  const { config: globalConfig, isError: configError, revalidate: refreshConfig } = useConfig();
  const presentation = usePresentationView();
  const aiEnabled = presentation?.aiEnabled === true && (aiOnly || presentation.aiOnMonitorPage);
  const { monitorGroups, monitoringData, isLoading, isError, receivedAt } = useMonitorData(undefined, !aiOnly);
  const ai = usePublicAiModels(aiEnabled);
  const websiteSubscriptions = usePublicSubscriptions('website', !aiOnly);
  const modelSubscriptions = usePublicSubscriptions('model', aiEnabled);
  const aiHidden = ai.error instanceof ApiError && [401, 403, 404].includes(ai.error.status);
  const aiModels = !aiEnabled || aiHidden ? [] : ai.data?.models ?? [];
  const { searchTerm, isFiltering, clearSearch, filterStatus, searchInGroup } = useMonitorFilters();
  const { pageId } = usePageConfig();
  const viewKey = aiOnly ? 'uptime-polaris.ai.view' : VIEW_KEY;

  const [view, setView] = useState<ViewMode>(() => {
    try {
      const saved = window.localStorage.getItem(viewKey);
      return saved === 'grid' || !saved && presentation?.layout === 'cards' ? 'grid' : 'list';
    } catch {
      return 'list';
    }
  });
  const changeView = (next: ViewMode) => {
    setView(next);
    try {
      window.localStorage.setItem(viewKey, next);
    } catch {
      // Private browsing: the choice lasts for this visit only. / 隐私浏览模式下，选择仅在本次访问中保留。
    }
  };

  const [refreshError, setRefreshError] = useState(false);
  const refresh = useCallback(async () => {
    try {
      await Promise.all([aiOnly ? refreshConfig() : revalidateData(pageId, undefined, refreshConfig), ...(aiEnabled ? [revalidateData(pageId, SWR_KEYS.AI(pageId))] : [])]);
      await Promise.all([!aiOnly ? websiteSubscriptions.mutate() : undefined, aiEnabled ? modelSubscriptions.mutate() : undefined]);
      setRefreshError(false);
    } catch (error) {
      setRefreshError(true);
      throw error;
    }
  }, [pageId, refreshConfig, aiOnly, aiEnabled, websiteSubscriptions.mutate, modelSubscriptions.mutate]);
  const timer = useRefreshTimer(refresh, 60_000, receivedAt);

  const counts = useMemo(() => {
    const result = calculateMonitorStatusCounts(monitorGroups, monitoringData.heartbeatList ?? {});
    for (const model of aiModels) {
      const state = ai.error ? 'unknown' : aiStatusKey(model.live);
      result.total++; result[state]++; if (state !== 'up') result.abnormal++;
    }
    for (const item of [...websiteSubscriptions.items, ...modelSubscriptions.items]) {
      const state = (item.category === 'website' ? websiteSubscriptions.error : modelSubscriptions.error) ? 'unknown' : subscriptionBucket(item);
      result.total++; result[state]++; if (state !== 'up') result.abnormal++;
    }
    return result;
  }, [monitorGroups, monitoringData.heartbeatList, aiModels, ai.error, websiteSubscriptions.items, modelSubscriptions.items, websiteSubscriptions.error, modelSubscriptions.error]);
  const systemStatus = selectSystemStatus(counts);
  const status = systemStatus === 'normal' && (ai.error || isError || websiteSubscriptions.error || modelSubscriptions.error) ? 'warning' : systemStatus;

  // The day's availability across every monitor that has a reading, for the hero. / 汇总有读数的监控项当日可用率，供概览使用。
  const uptime24h = useMemo(() => {
    const values = monitorGroups
      .flatMap((group) => group.monitorList)
      .filter((monitor) => monitor.sourceAvailable !== false)
      .map((monitor) => monitoringData.uptimeList[`${monitor.id}_24`])
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  }, [monitorGroups, monitoringData.uptimeList]);

  /*
    Search and status filter. A group whose name matches (when "search in
    groups" is on) keeps all of its monitors that pass the status filter;
    otherwise a monitor matches on its name, URL or tags.

    搜索分组时，名称匹配的分组保留所有通过状态筛选的监控项；
    否则按监控项名称、URL 或标签匹配。
  */
  const groups = useMemo<PageGroup[]>(() => {
    if (!isFiltering) return monitorGroups;
    const term = searchTerm.toLowerCase();
    const passes = (monitor: Monitor) => filterMonitorByStatus(monitor, filterStatus, monitoringData.heartbeatList);

    return monitorGroups
      .map((group): PageGroup | null => {
        // The ungrouped bucket has no name until the UI localises it, so a
        // group-name search simply does not match it.
        // 未分组项的名称由界面本地化，因此分组名称搜索不会匹配该项。
        if (searchInGroup && term && group.name?.toLowerCase().includes(term)) {
          return { ...group, monitorList: group.monitorList.filter(passes), isGroupMatched: true };
        }
        const list = group.monitorList.filter((monitor) => {
          if (!passes(monitor)) return false;
          if (!term) return true;
          return (
            monitor.name.toLowerCase().includes(term) ||
            monitor.url?.toLowerCase().includes(term) ||
            monitor.tags?.some((tag) => tag.name.toLowerCase().includes(term))
          );
        });
        return list.length ? { ...group, monitorList: list, isGroupMatched: false } : null;
      })
      .filter((group): group is PageGroup => group !== null && group.monitorList.length > 0);
  }, [filterStatus, isFiltering, monitorGroups, monitoringData.heartbeatList, searchInGroup, searchTerm]);

  const shownAi = filterAiModels(aiModels, searchTerm, filterStatus, Boolean(ai.error), aiOnly || searchInGroup);
  const shownWebsites = filterSubscriptions(websiteSubscriptions.items, searchTerm, filterStatus);
  const shownModels = filterSubscriptions(modelSubscriptions.items, searchTerm, filterStatus);
  const matched = groups.reduce((sum, group) => sum + group.monitorList.length, 0) + shownAi.length + shownWebsites.length + shownModels.length;

  return (
    <div className="pb-6">
      {globalConfig?.config.description && <p className="pt-4 text-small text-[var(--polaris-ink-3)]">{globalConfig.config.description}</p>}
      <StatusHero aiOnly={aiOnly} counts={counts} status={status} loading={isLoading || ai.isLoading} timer={timer} uptime24h={presentation?.showAvailability === false || aiModels.length > 0 || websiteSubscriptions.items.length > 0 || modelSubscriptions.items.length > 0 ? null : uptime24h} />

      {(isError || configError || refreshError) && receivedAt !== null ? (
        <p role="status" className="mb-5 flex items-center gap-2 text-[13px] text-[var(--polaris-ink-2)]">
          <CloudOff size={16} aria-hidden="true" />
          {t('timer.staleData')}
        </p>
      ) : null}


      <Toolbar aiOnly={aiOnly} counts={counts} view={view} onView={changeView} matched={matched} />

      {isLoading ? (
        <GroupSkeleton />
      ) : isError && monitorGroups.length === 0 ? (
        <div className="polaris-card flex flex-col items-center px-6 py-14 text-center">
          <CloudOff size={22} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
          <p className="mt-3 text-[14px] font-semibold">{t('error.requestData')}</p>
          <button
            type="button"
            onClick={timer.refresh}
            className="mt-4 h-8 rounded-lg border border-[var(--polaris-line-strong)] bg-[var(--polaris-card)] px-3 text-[12.5px] font-medium text-[var(--polaris-ink-2)] transition-colors hover:text-[var(--polaris-ink)]"
          >
            {t('timer.refreshNow')}
          </button>
        </div>
      ) : groups.length === 0 && shownAi.length === 0 && !shownWebsites.length && !shownModels.length && !ai.isLoading && !websiteSubscriptions.isLoading && !modelSubscriptions.isLoading ? (
        <div className="polaris-card flex flex-col items-center px-6 py-14 text-center">
          <SearchX size={22} className="text-[var(--polaris-ink-4)]" aria-hidden="true" />
          <p className="mt-3 text-[14px] font-semibold">
            {isFiltering ? t('node.noMatchingResults') : t(aiOnly ? 'ai.empty' : 'common.list.empty')}
          </p>
          {isFiltering ? (
            <button
              type="button"
              onClick={clearSearch}
              className="mt-4 h-8 rounded-lg border border-[var(--polaris-line-strong)] bg-[var(--polaris-card)] px-3 text-[12.5px] font-medium text-[var(--polaris-ink-2)] transition-colors hover:text-[var(--polaris-ink)]"
            >
              {t('node.clearFilter')}
            </button>
          ) : null}
        </div>
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={view}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0, transition: CONTENT_TRANSITION }}
            exit={{ opacity: 0, y: -4, transition: { duration: 0.12, ease: MOTION_EASE } }}
          >
            {groups.map((group, index) => (
              <GroupSection key={group.id} group={group} data={monitoringData} view={view} index={index} />
            ))}
          </motion.div>
        </AnimatePresence>
      )}
      {aiEnabled && !aiHidden ? <AiModels models={shownAi} view={view} filtering={isFiltering} error={Boolean(ai.error)} loading={ai.isLoading} retry={() => { void ai.mutate().catch(() => undefined); }} /> : null}
      {!aiOnly && !websiteSubscriptions.hidden ? <PublicSubscriptions category="website" items={shownWebsites} view={view} error={Boolean(websiteSubscriptions.error)} loading={websiteSubscriptions.isLoading} retry={() => void websiteSubscriptions.mutate()} /> : null}
      {aiEnabled && !modelSubscriptions.hidden ? <PublicSubscriptions category="model" items={shownModels} view={view} error={Boolean(modelSubscriptions.error)} loading={modelSubscriptions.isLoading} retry={() => void modelSubscriptions.mutate()} /> : null}
    </div>
  );
}
