import { ApiError } from '@/api/errors';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { useTranslations } from 'use-intl';
import { useCallback } from 'react';

export function useAiError() {
  const t = useTranslations('admin.ai');
  const fallback = useApiErrorMessage();
  return useCallback((error: unknown) => {
    const key = error instanceof ApiError ? `errors.${error.code}` : '';
    return key && t.has(key) ? t(key) : fallback(error);
  }, [t, fallback]);
}
