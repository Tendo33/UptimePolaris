import { requestJson } from '@/api/client';
import { isRetryableApiError } from '@/api/errors';
import useSWR from 'swr';
import type { AiChannel, AiChannelDetails, AiChannelInput, AiChannelUpdate, AiManualResult, AiModel, AiModelInput, AiModelUpdate, AiRemoteModels } from '../../../../shared/ai-management';

const root = '/api/admin/ai';
const path = (kind: 'channels' | 'models', id: string) => `${root}/${kind}/${encodeURIComponent(id)}`;
const write = <T>(url: string, method: string, body: unknown) => requestJson<T>(url, { method, body: JSON.stringify(body) });

export const AI_KEY = 'console:ai';

export const aiApi = {
  async list() {
    const [channels, models] = await Promise.all([
      requestJson<{ channels: AiChannel[] }>(`${root}/channels`),
      requestJson<{ models: AiModel[] }>(`${root}/models`),
    ]);
    return { ...channels, ...models };
  },
  channel: (id: string) => requestJson<{ channel: AiChannelDetails }>(path('channels', id)),
  model: (id: string) => requestJson<{ model: AiModel }>(path('models', id)),
  createChannel: (input: AiChannelInput) => write<{ channel: AiChannel }>(`${root}/channels`, 'POST', input),
  updateChannel: (id: string, input: AiChannelUpdate) => write<{ channel: AiChannel }>(path('channels', id), 'PUT', input),
  createModel: (input: AiModelInput) => write<{ model: AiModel }>(`${root}/models`, 'POST', input),
  updateModel: (id: string, input: AiModelUpdate) => write<{ model: AiModel }>(path('models', id), 'PUT', input),
  remove: (kind: 'channels' | 'models', id: string, revision: string) => write<{ ok: true }>(path(kind, id), 'DELETE', { revision }),
  remoteModels: (channel: AiChannel) => requestJson<AiRemoteModels>(`${path('channels', channel.id)}/models`),
  testChannel: (channel: AiChannel) => write<{ result: AiManualResult }>(`${path('channels', channel.id)}/test`, 'POST', { revision: channel.revision }),
  checkModel: (model: AiModel, channel: AiChannel) => write<{ result: AiManualResult }>(`${path('models', model.id)}/check`, 'POST', {
    revision: model.revision, channelRevision: channel.revision, confirmPaid: true,
  }),
};

export function useAiData(enabled: boolean, refreshInterval = 0) {
  return useSWR(enabled ? AI_KEY : null, aiApi.list, {
    refreshInterval,
    revalidateOnFocus: true,
    keepPreviousData: true,
    dedupingInterval: 5_000,
    shouldRetryOnError: isRetryableApiError,
    errorRetryCount: 2,
  });
}

/** The channel's own model list, read only when asked for. / 渠道自身的模型列表，仅在需要时读取。 */
export function useRemoteModels(channel: AiChannel, requested: boolean) {
  return useSWR(requested ? ['console:ai:remote', channel.id, channel.revision] : null, () => aiApi.remoteModels(channel), {
    revalidateOnFocus: false,
    revalidateIfStale: false,
    shouldRetryOnError: false,
  });
}
