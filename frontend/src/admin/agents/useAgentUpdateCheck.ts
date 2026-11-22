import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { toast } from '@/components/ui/toast';
import { agentsApi } from './api';

export function useAgentUpdateCheck(onUpdated?: () => void | Promise<void>) {
  const t = useTranslations('admin.agents');
  const errorMessage = useApiErrorMessage();
  const [checking, setChecking] = useState(false);
  const locked = useRef(false), mounted = useRef(false);
  const callback = useRef(onUpdated);
  callback.current = onUpdated;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);

  const check = async () => {
    if (locked.current) return;
    locked.current = true; setChecking(true);
    try {
      const result = await agentsApi.checkUpdate();
      if (!mounted.current) return;
      await callback.current?.();
      if (mounted.current) toast.success(t('versionChecked', { version: result.latestVersion }));
    } catch (failure) {
      if (mounted.current) toast.error(errorMessage(failure));
    } finally {
      locked.current = false;
      if (mounted.current) setChecking(false);
    }
  };
  return { checking, check };
}
