import { publicPathKind } from '../../../shared/public-page-paths';

export function publicApiUrl(
  path: string,
  pageId?: string,
  location: Pick<Location, 'origin' | 'search'> & Partial<Pick<Location, 'pathname'>> = window.location,
): string {
  const url = new URL(path, location.origin);
  const kind = publicPathKind(location.pathname ?? '');
  if (kind) url.searchParams.set('view', kind);
  if (pageId !== undefined) url.searchParams.set('pageId', pageId);
  const preview = new URLSearchParams(location.search).get('preview');
  if (preview === 'monitor' || preview === 'agent' || preview === 'ai') url.searchParams.set('preview', preview);
  return url.href;
}
