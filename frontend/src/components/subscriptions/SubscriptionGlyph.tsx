import { publicApiUrl } from '@/api/public-url';
import { GlyphTile, TILE, type GlyphSize } from '@/components/ui/GlyphTile';
import type { Tone } from '@/types/tone';
import { Bot, Globe } from 'lucide-react';
import { useState } from 'react';
import type { SubscriptionCategory } from '../../../../shared/subscriptions';

export function SubscriptionGlyph({ id, category, publicView = false, pageId, size = 'md', badge }: { id: string; category: SubscriptionCategory; publicView?: boolean; pageId?: string; size?: GlyphSize; badge?: Tone }) {
  const path = publicView ? `/api/public/subscriptions/icons/${encodeURIComponent(id)}` : `/api/admin/subscriptions/${encodeURIComponent(id)}/icon`;
  const src = publicView ? publicApiUrl(path, pageId) : path;
  return <SiteGlyph key={src} src={src} category={category} size={size} badge={badge} />;
}

function SiteGlyph({ src, category, size, badge }: { src: string; category: SubscriptionCategory; size: GlyphSize; badge?: Tone }) {
  const [state, setState] = useState<'loading' | 'loaded' | 'failed'>('loading');
  const Icon = category === 'model' ? Bot : Globe;
  const px = TILE[size].px;
  return (
    <GlyphTile size={size} badge={badge}>
      <Icon size={px} className={state === 'loaded' ? 'opacity-0' : undefined} />
      {state !== 'failed' ? <img src={src} alt="" width={px} height={px} loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={event => setState(event.currentTarget.naturalWidth >= 8 && event.currentTarget.naturalHeight >= 8 ? 'loaded' : 'failed')} onError={() => setState('failed')} className={`absolute rounded-sm ${state === 'loaded' ? 'opacity-100' : 'opacity-0'}`} /> : null}
    </GlyphTile>
  );
}
