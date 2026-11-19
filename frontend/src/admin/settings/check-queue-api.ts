import { requestJson } from '@/api/client';
import type { CheckQueueProbeInput, CheckQueueStatus, CheckQueueUpdate } from '../../../../shared/check-queue';

const root = '/api/admin/check-queue';
export const checkQueueApi = {
  status: () => requestJson<CheckQueueStatus>(root),
  probe: (input: CheckQueueProbeInput) => requestJson<CheckQueueStatus>(`${root}/probe`, { method: 'POST', body: JSON.stringify(input) }),
  update: (input: CheckQueueUpdate) => requestJson<CheckQueueStatus>(root, { method: 'PUT', body: JSON.stringify(input) }),
};
