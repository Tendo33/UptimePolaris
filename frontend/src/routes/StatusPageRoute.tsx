import { PageConfigProvider } from '@/components/context/PageConfigContext';
import { PresentationViewContext } from '@/components/context/PresentationViewContext';
import { MonitorDataPreload } from '@/components/status-page/MonitorDataPreload';
import { StatusPage } from '@/components/status-page/StatusPage';
import { StatusPageShell } from '@/components/status-page/StatusPageShell';
import { toPageConfig } from '@/config/api';
import { usePublicConfig } from '@/config/usePublicConfig';
import { useParams } from 'react-router';
import { RouteError, RouteLoading } from './RouteStates';

export function StatusPageRoute() {
  const { pageId } = useParams<{ pageId?: string }>();
  const { data, error, mutate, key } = usePublicConfig(pageId);
  if (!data) return error ? <RouteError code="render" error={error} onRetry={() => { void mutate(); }} /> : <RouteLoading />;
  const config = toPageConfig(data);

  return (
    <PageConfigProvider key={key} initialConfig={config} configKey={key}>
      <PresentationViewContext.Provider value={data.presentation}>
        <StatusPageShell>
          {data.presentation.kind !== 'ai' ? <MonitorDataPreload pageId={config.pageId} /> : null}
          <StatusPage key={data.presentation.kind} aiOnly={data.presentation.kind === 'ai'} />
        </StatusPageShell>
      </PresentationViewContext.Provider>
    </PageConfigProvider>
  );
}
