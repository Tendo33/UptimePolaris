export const SUBSCRIPTION_LIMITS = {
  descriptorBytes: 262144,
  responseBytes: 2097152,
  runBytes: 10485760,
  catalogBytes: 1048576,
  catalogEntries: 500,
  items: 1000,
  requests: 8,
  fetches: 10,
  redirects: 3,
  timeoutMs: 10000,
  runTimeoutMs: 30000,
  previewSec: 600,
  minimumIntervalSec: 60,
  maximumIntervalSec: 86400,
  recent: 60,
  historyDays: 90,
} as const;

export const SUBSCRIPTION_STATUSES = ['up', 'down', 'degraded', 'pending', 'maintenance', 'unknown'] as const;
export type SubscriptionStatus = typeof SUBSCRIPTION_STATUSES[number];
export type SubscriptionCategory = 'website' | 'model';
export type SubscriptionMode = 'heartbeat' | 'snapshot';
export type SubscriptionFreshness = 'current' | 'stale' | 'never_received' | 'paused' | 'removed' | 'configuration_changed';
export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

export interface SubscriptionInput {
  type: 'url' | 'string' | 'number' | 'boolean' | 'secret' | 'enum';
  required?: boolean;
  label?: string;
  description?: string;
  default?: string | number | boolean;
  options?: string[];
}

export interface SubscriptionPagination {
  type: 'page' | 'cursor';
  parameter: string;
  location: 'query' | 'body';
  start?: number;
  nextPath?: string;
  itemsPath: string;
  maxPages: number;
}

export interface SubscriptionRequest {
  baseUrlInput: string;
  method: 'GET' | 'POST';
  path: string;
  intervalSec: number;
  response: 'json';
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: JsonValue;
  pagination?: SubscriptionPagination;
}

export interface SubscriptionField {
  path?: string;
  from?: 'item' | 'parent' | 'root';
  constant?: string | number | boolean | null;
  default?: string | number | boolean | null;
  prefix?: string;
  suffix?: string;
  number?: boolean;
  scale?: number;
}
export type SubscriptionSelector = string | SubscriptionField;
export type SubscriptionFilter =
  | { op: 'eq'; path: string; value: JsonValue }
  | { op: 'in'; path: string; values: JsonValue[] }
  | { op: 'exists'; path: string }
  | { op: 'and'; conditions: SubscriptionFilter[] };

export interface SubscriptionTime {
  path: string;
  format: 'iso8601' | 'unix-seconds' | 'unix-milliseconds' | 'yyyy-MM-dd HH:mm:ss[.SSS]';
  timeZone?: 'UTC';
}

export interface SubscriptionDescriptor {
  schemaVersion: 1;
  id: string;
  version: string;
  name: string;
  description: string;
  categories: SubscriptionCategory[];
  capabilities: string[];
  inputs: Record<string, SubscriptionInput>;
  sourcePage?: { baseUrlInput: string; path: string };
  requests: Record<string, SubscriptionRequest>;
  items: {
    request: string;
    path: string;
    filter?: SubscriptionFilter;
    fields: {
      id: SubscriptionSelector;
      name: SubscriptionSelector;
      group?: SubscriptionSelector;
      url?: SubscriptionSelector;
      modelId?: SubscriptionSelector;
      provider?: SubscriptionSelector;
      protocol?: SubscriptionSelector;
    };
  };
  observations: {
    currentWhen?: SubscriptionFilter;
    request: string;
    path?: string;
    lookupBy?: 'item.id';
    join?: { path: string; itemPath?: string };
    mode: SubscriptionMode;
    latestBy?: string;
    observedAt?: SubscriptionTime;
    changedAt?: SubscriptionTime;
    status: { path: string; map: Record<string, SubscriptionStatus>; fallback: 'unknown' };
    latency?: { path: string; unit: 'ms' | 's' };
    reason?: string;
  };
  metrics?: {
    availability?: {
      request: string;
      path: string;
      lookupBy?: 'item.id';
      suffix?: string;
      unit: 'ratio' | 'percent';
      windowSec: number;
    };
  };
}

export interface SubscriptionIssue {
  code: string;
  path: string;
  requestId?: string;
  itemId?: string;
}

export class SubscriptionError extends Error {
  retryAfterSec?: number;
  constructor(public code: string, public status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500 | 502 | 503 = 400, public issues: SubscriptionIssue[] = []) {
    super(code);
    this.name = 'SubscriptionError';
  }
}

export interface SubscriptionObservation {
  status: SubscriptionStatus;
  observedAt: number | null;
  changedAt: number | null;
  fetchedAt: number;
  latencyMs: number | null;
  reason: string | null;
}

export interface SubscriptionSourceItem {
  sourceCurrent?: boolean;
  sourceItemId: string;
  name: string;
  group: string | null;
  url: string | null;
  modelId: string | null;
  provider: string | null;
  protocol: string | null;
  mode: SubscriptionMode;
  observation: SubscriptionObservation | null;
  recent: SubscriptionObservation[];
  availability: { value: number; windowSec: number; fetchedAt: number; origin: 'source' } | null;
}

export interface SubscriptionParseResult {
  items: SubscriptionSourceItem[];
  issues: SubscriptionIssue[];
  complete: boolean;
}

export interface SubscriptionNotificationPolicy {
  notificationEnabled: boolean;
  notificationChannelIds: string[];
}

export interface Subscription {
  id: string;
  name: string;
  category: SubscriptionCategory;
  enabled: boolean;
  archivedAt: number | null;
  isPublic: boolean;
  autoSubscribe: boolean;
  intervalSec: number;
  staleAfterSec: number;
  revision: string;
  syncRevision: string;
  configId: string;
  templateName: string;
  templateVersion: string;
  sourceUrl: string | null;
  origin: 'official' | 'local';
  createdAt: number;
  updatedAt: number;
  notifications: {
    monitor: SubscriptionNotificationPolicy;
    sync: SubscriptionNotificationPolicy & { afterSec: number };
  };
  runtime: SubscriptionRuntime;
  sourceHosts?: string[];
  sourcePageUrl?: string | null;
  statusCounts?: Partial<Record<SubscriptionStatus, number>>;
  configUpdate?: { checkedAt: number; version: string | null; changed: boolean; conflict: boolean; error: string | null };
}

export interface SubscriptionSummary {
  total: number;
  items: number;
  healthy: number;
  partial: number;
  failed: number;
  paused: number;
  archived: number;
}

export function subscriptionHealth(subscription: Subscription) {
  return subscription.archivedAt !== null ? 'archived' : !subscription.enabled ? 'paused' : subscription.runtime.health;
}

export interface SubscriptionRuntime {
  runId: string | null;
  phase: 'idle' | 'queued' | 'fetching' | 'parsing' | 'committing';
  health: 'healthy' | 'partial' | 'failed';
  lastAttemptAt: number | null;
  lastSuccessAt: number | null;
  nextDueAt: number;
  failureSince: number | null;
  failures: number;
  announcedFailure: boolean;
  error: string | null;
  itemCount: number;
  selectedCount: number;
}

export interface SubscriptionDay {
  date: string;
  total: number;
  up: number;
  availabilityPct: number | null;
  origin: 'received_observations';
}

export interface SubscriptionItem extends SubscriptionSourceItem {
  identityArchived?: boolean;
  id: string;
  subscriptionId: string;
  category: SubscriptionCategory;
  revision: string;
  selected: boolean;
  isPublic: boolean;
  muted: boolean;
  localName: string | null;
  groupId: string | null;
  sortOrder: number;
  removedAt: number | null;
  syncRevision: string;
  baseline: boolean;
  announced: SubscriptionStatus | null;
  observationWatermark: number | null;
  days: SubscriptionDay[];
  freshness: SubscriptionFreshness;
  displayStatus: SubscriptionStatus;
}

export interface SubscriptionConfig {
  id: string;
  descriptor: SubscriptionDescriptor;
  parameters: Record<string, string | number | boolean>;
  secretNames: string[];
  sourceUrl: string | null;
  origin: 'official' | 'local';
  modified: boolean;
  fetchedAt: number;
}

export interface PublicSubscriptionItem {
  id: string; category: SubscriptionCategory; name: string;
  source: { id: string; name: string; url: string | null };
  group: string | null; modelId: string | null; provider: string | null; protocol: string | null;
  mode: SubscriptionMode; freshness: SubscriptionFreshness; status: SubscriptionStatus;
  observation: SubscriptionObservation | null; recent: SubscriptionObservation[];
  availability: SubscriptionSourceItem['availability'];
}

export interface SubscriptionCatalogEntry {
  id: string;
  name: string;
  description: string;
  categories: SubscriptionCategory[];
  kind: 'template' | 'site';
  version: string;
  path: string;
  capabilities: string[];
  verifiedAt: string | null;
  limitations: string[];
  origin: 'official' | 'local';
  installedCount?: number;
  minimumAppVersion?: string;
  versions?: { version: string; path: string }[];
}

export interface SubscriptionPreview {
  id: string;
  state: 'running' | 'ready' | 'partial' | 'failed';
  config: SubscriptionConfig;
  items: SubscriptionSourceItem[];
  issues: SubscriptionIssue[];
  createdAt: number;
  expiresAt: number;
  error: string | null;
  identity?: { changed: boolean; previous: { id: string; sourceItemId: string; name: string }[]; added: string[]; removed: string[] };
}

export function selectableSubscriptionItem(item: SubscriptionSourceItem, issues: SubscriptionIssue[]): boolean {
  return item.observation !== null && !issues.some(issue => issue.itemId === item.sourceItemId);
}

export const subscriptionRuntime = (): SubscriptionRuntime => ({
  runId: null, phase: 'idle', health: 'healthy', lastAttemptAt: null, lastSuccessAt: null,
  nextDueAt: 0, failureSince: null, failures: 0, announcedFailure: false, error: null, itemCount: 0, selectedCount: 0,
});

export const subscriptionNotifications = (): Subscription['notifications'] => ({
  monitor: { notificationEnabled: false, notificationChannelIds: [] },
  sync: { notificationEnabled: false, notificationChannelIds: [], afterSec: 300 },
});
