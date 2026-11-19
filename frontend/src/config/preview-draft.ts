import { useSyncExternalStore } from 'react';
import type { PresentationView } from '@/components/context/PresentationViewContext';
import type { PublicConfigResponse } from './api';

// 主题编辑器把未保存的配置推送给同源预览页，预览页只在 ?preview= 且被嵌入时接收。
// The theme editor pushes unsaved settings into a same-origin preview frame.

export const PREVIEW_DRAFT_MESSAGE = 'polaris-preview:draft';
export const PREVIEW_READY_MESSAGE = 'polaris-preview:ready';

export type PreviewDraftView = Pick<PresentationView,
  'accent' | 'radius' | 'width' | 'density' | 'layout' | 'columns'
  | 'showHistory' | 'showLatency' | 'showAvailability' | 'showExpiry' | 'showCountry'>;

export interface PreviewDraft {
  kind: 'monitor' | 'agent' | 'ai';
  view: PreviewDraftView;
  headCode: string;
  contentHtml: string;
}

let draft: PreviewDraft | null = null;
const listeners = new Set<() => void>();

function previewKind() {
  if (typeof window === 'undefined' || window.parent === window) return null;
  const kind = new URLSearchParams(window.location.search).get('preview');
  return kind === 'monitor' || kind === 'agent' || kind === 'ai' ? kind : null;
}

const kind = previewKind();
if (kind) {
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const data = event.data as Partial<PreviewDraft> & { type?: string };
    if (data?.type !== PREVIEW_DRAFT_MESSAGE || data.kind !== kind || !data.view) return;
    draft = { kind, view: data.view, headCode: String(data.headCode ?? ''), contentHtml: String(data.contentHtml ?? '') };
    listeners.forEach((listener) => listener());
  });
  window.parent.postMessage({ type: PREVIEW_READY_MESSAGE, kind }, window.location.origin);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function usePreviewDraft() {
  return useSyncExternalStore(subscribe, () => draft, () => null);
}

export function applyPreviewDraft(config: PublicConfigResponse, value: PreviewDraft | null): PublicConfigResponse {
  if (!value || config.presentation?.kind !== value.kind) return config;
  return {
    ...config,
    presentation: { ...config.presentation, ...value.view },
    config: { ...config.config, showCertificateExpiry: value.view.showExpiry },
    theme_head_code: value.headCode,
    theme_content_html: value.contentHtml,
  };
}
