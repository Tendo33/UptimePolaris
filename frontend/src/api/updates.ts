import { requestJson } from '@/api/client';
import { ApiError, UnauthorizedError } from '@/api/errors';
import { useState } from 'react';
import useSWR from 'swr';

export type UpdateState = {
  current: string;
  latest?: string;
  mode: 'native' | 'docker';
  os: string;
  arch: string;
  supported: boolean;
  automatic: boolean;
  phase: 'idle' | 'checking' | 'downloading' | 'restarting' | 'verifying' | 'complete' | 'rolled_back' | 'failed';
  error?: string;
  checkedAt: number;
  updatedAt: number;
};

const activePhases = new Set(['checking', 'downloading', 'restarting', 'verifying']);
export function useManagedUpdates(enabled: boolean) {
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState<string>();
  const resource = useSWR<UpdateState>(enabled ? '/api/admin/updates' : null, (path: string) => requestJson(path, { signal: AbortSignal.timeout(8_000) }), {
    refreshInterval: (data) => pending || activePhases.has(data?.phase ?? '') ? 2_000 : 60_000,
    refreshWhenHidden: false, revalidateOnFocus: true, errorRetryInterval: 2_000,
    shouldRetryOnError: (error) => !(error instanceof UnauthorizedError),
  });
  const command = async (action: 'check' | 'apply' | 'policy', body?: object) => {
    if (pending) return;
    setPending(true);
    setActionError(undefined);
    try {
      const state = await requestJson<UpdateState>(`/api/admin/updates/${action}`, {
        method: action === 'policy' ? 'PUT' : 'POST', body: body && JSON.stringify(body), signal: AbortSignal.timeout(8_000),
      });
      await resource.mutate(state, { revalidate: false });
    } catch (error) {
      setActionError(error instanceof ApiError ? error.code : 'update_request_failed');
      void resource.mutate().catch(() => undefined);
    } finally {
      setPending(false);
    }
  };
  return { ...resource, command, actionError, pending, busy: pending || activePhases.has(resource.data?.phase ?? '') };
}
