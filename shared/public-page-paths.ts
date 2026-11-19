import type { PageKind } from './presentation';

export const PUBLIC_PAGE_PATHS: Record<PageKind, string> = { monitor: '/', agent: '/servers', ai: '/ai' };

export function publicPathKind(pathname: string): 'agent' | 'ai' | null {
  const path = pathname.replace(/\/$/, '');
  if (path === '/ai') return 'ai';
  if (path === '/servers' || /^\/server\/[^/]+$/.test(path)) return 'agent';
  return null;
}
