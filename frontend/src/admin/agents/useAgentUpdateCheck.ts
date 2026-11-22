import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { toast } from '@/components/ui/toast';
import { agentsApi } from './api';

export function useAgentUpdateCheck(onUpdated?: () => void | Promise<void>) {
  const t = useTranslations('admin.agents');
  const errorMessage = useApiErrorMessage();
  const [checking, setChecking] = useState(false);
  const [result, setResult] = useState<{ latestVersion: string } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const locked = useRef(false), mounted = useRef(false);
  const request = useRef<AbortController | null>(null);
  const callback = useRef(onUpdated);
  callback.current = onUpdated;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; request.current?.abort(); }; }, []);

  const check = async () => {
    if (locked.current) return;
    locked.current = true; setChecking(true);
    setResult(null); setError(null);
    const controller = new AbortController();
    request.current = controller;
    const timeout = setTimeout(() => controller.abort(new DOMException('Update check timed out', 'TimeoutError')), 17_000);
    try {
      const result = await agentsApi.checkUpdate(controller.signal);
      if (!mounted.current) return;
      setResult(result);
      toast.success(t('versionChecked', { version: result.latestVersion }));
    } catch (failure) {
      if (mounted.current) {
        setError(failure);
        toast.error(errorMessage(failure));
      }
      return;
    } finally {
      clearTimeout(timeout);
      request.current = null;
      locked.current = false;
      if (mounted.current) setChecking(false);
    }
    if (!mounted.current) return;
    try {
      await callback.current?.();
    } catch (failure) {
      if (mounted.current) toast.error(errorMessage(failure));
    }
  };
  return { checking, result, error, check };
}
