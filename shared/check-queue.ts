export type CheckQueueErrorCode = 'binding_missing' | 'schema_required' | 'storage_unavailable' | 'revision_conflict' | 'writer_busy' | 'probe_required' | 'probe_pending' | 'probe_timeout' | 'enqueue_failed' | 'consumer_failed' | 'capacity_exceeded' | 'invalid_request';
export interface CheckQueueStatus {
  supported: true;
  bound: boolean;
  enabled: boolean;
  canEnable: boolean;
  schema: 'ready' | 'missing' | 'unavailable';
  revision: string | null;
  verification: {
    state: 'never' | 'pending' | 'passed' | 'timed_out' | 'failed';
    startedAt: number | null;
    expiresAt: number | null;
    processedAt: number | null;
  };
  lastEnqueuedAt: number | null;
  lastProcessedAt: number | null;
  oldestPendingAt: number | null;
  pendingTasks: number;
  lastError: {
    code: CheckQueueErrorCode;
    at: number;
  } | null;
  limits: {
    tasksPerMessage: 10;
    pendingTasks: 1000;
    externalRequestsPerInvocation: 50;
    aePointsPerInvocation: 250;
    recommendedBatchSize: 1;
    recommendedConcurrency: 1;
  };
}
export interface CheckQueueUpdate {
  enabled: boolean;
  revision: string;
}
export interface CheckQueueProbeInput {
  revision: string;
}
export interface CheckQueueTask {
  kind: 'monitor' | 'ai' | 'subscription';
  id: string;
  version: string;
  channelVersion?: string;
  token: string;
  scheduledAt: number;
  expiresAt: number;
}
export type CheckQueueMessage = {
  type: 'probe';
  id: string;
  generation: string;
  createdAt: number;
  expiresAt: number;
} | {
  type: 'checks';
  id: string;
  generation: string;
  createdAt: number;
  expiresAt: number;
  tasks: CheckQueueTask[];
};
