import { lazy, Suspense, useEffect } from 'react';
import { ApiError } from '@/api/errors';
import { StatusPageRoute } from './StatusPageRoute';
import { RouteError, RouteLoading } from './RouteStates';
import { PresentationViewContext } from '@/components/context/PresentationViewContext';
import { usePublicConfig } from '@/config/usePublicConfig';
import { applyDefaultTheme } from '@/lib/browser-preferences';
import { useTheme } from 'next-themes';
import { useLocale } from '@/i18n/IntlProvider';

const PublicServersPage = lazy(() => import('@/components/servers/PublicServersPage').then(module => ({ default: module.PublicServersPage })));

export function PublicPageRoute() {
  const { data: config, error, refresh, isValidating } = usePublicConfig();
  const { setTheme } = useTheme();
  const { applyDefaultLocale } = useLocale();
  useEffect(() => {
    if (!config || config.presentation.kind === 'monitor') return;
    applyDefaultTheme(config.presentation.colorMode, setTheme);
    const controller = new AbortController();
    void applyDefaultLocale(config.presentation.locale, controller.signal).catch(() => undefined);
    return () => controller.abort();
  }, [config?.presentation.kind, config?.presentation.colorMode, config?.presentation.locale, setTheme, applyDefaultLocale]);
  if (!config) return error instanceof ApiError && error.status === 404 ? <RouteError code="notFound" /> : error ? <RouteError code="render" error={error} onRetry={() => { void refresh().catch(() => undefined); }} /> : <RouteLoading />;
  if (!config.presentation.configured || !config.presentation.enabled) return <RouteError code="notFound" />;
  return <PresentationViewContext.Provider value={config.presentation}><Suspense fallback={<RouteLoading />}>{config.presentation.kind === 'agent' ? <PublicServersPage config={config} configError={error} configRefreshing={isValidating} onRefreshConfig={refresh} /> : <StatusPageRoute />}</Suspense></PresentationViewContext.Provider>;
}
