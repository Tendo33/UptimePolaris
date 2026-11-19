import { ApiError } from '@/api/errors';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { Button, Input, SelectItem, Skeleton, Switch } from '@heroui/react';
import { Select } from '@/components/ui/MotionOverlays';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link, NavLink, useBlocker, useSearchParams } from 'react-router';
import { useFormatter, useTranslations } from 'use-intl';
import type { Subscription, SubscriptionDescriptor } from '../../../../shared/subscriptions';

export function SubscriptionTabs() {
  const t = useTranslations('admin.subscriptions');
  return <nav aria-label={t('title')} className="mb-6 flex gap-6 border-b border-divider">{[['/admin/subscriptions', 'mine'], ['/admin/subscriptions/library', 'library']].map(([to, key]) => <NavLink end key={to} to={to} className={({ isActive }) => `border-b-2 px-1 pb-3 text-small font-medium ${isActive ? 'border-primary text-primary' : 'border-transparent text-default-500'}`}>{t(key)}</NavLink>)}</nav>;
}
export function useSubscriptionError() {
  const t = useTranslations('admin.subscriptions.errors');
  const fallback = useApiErrorMessage();
  return (error: unknown) => { const code = typeof error === 'string' ? error : error instanceof ApiError ? error.code : error instanceof Error ? error.message : ''; return error instanceof SyntaxError ? t('json') : code && t.has(code) ? t(code) : typeof error === 'string' ? error : fallback(error); };
}
export function Failure({ error, retry }: { error: unknown; retry?: () => void }) {
  const describe = useSubscriptionError(), t = useTranslations('admin.subscriptions');
  if (!error) return null;
  return <div role="alert" className="flex flex-wrap items-center gap-3 rounded-medium bg-danger-50 p-4 text-small text-danger"><span>{describe(error)}</span>{retry ? <Button size="sm" variant="flat" onPress={retry}>{t('retry')}</Button> : null}</div>;
}
export function Loading() { return <div aria-busy="true" className="space-y-3">{[1, 2, 3].map(key => <Skeleton key={key} className="h-16 rounded-medium" />)}</div>; }
export function Timestamp({ value }: { value: number | null | undefined }) {
  const format = useFormatter(), t = useTranslations('admin.subscriptions');
  return <>{value ? format.dateTime(new Date(value * 1000), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : t('never')}</>;
}
export function Status({ value }: { value: string }) {
  const t = useTranslations('admin.subscriptions.status');
  const color = ['up', 'healthy', 'ready', 'current'].includes(value) ? 'text-success' : ['down', 'failed'].includes(value) ? 'text-danger' : ['degraded', 'partial', 'stale'].includes(value) ? 'text-warning' : 'text-default-500';
  return <span className={`inline-flex items-center gap-1.5 text-small ${color}`}><span aria-hidden className="h-1.5 w-1.5 rounded-full bg-current" />{t.has(value) ? t(value) : value}</span>;
}
export function subscriptionHealth(subscription: Subscription) { return subscription.archivedAt ? 'archived' : !subscription.enabled ? 'paused' : subscription.runtime.health; }
export function Pagination({ total, nextOffset }: { total: number; nextOffset: number | null }) {
  const t = useTranslations('admin.subscriptions'), [search, setSearch] = useSearchParams();
  const offset = Number(search.get('offset') ?? 0);
  const go = (value: number) => { const next = new URLSearchParams(search); next.set('offset', String(value)); setSearch(next); };
  return <div className="flex items-center justify-between gap-3 py-4 text-small text-default-500"><span>{t('total', { count: total })}</span><div className="flex gap-2"><Button size="sm" variant="flat" isDisabled={!offset} onPress={() => go(Math.max(0, offset - 50))}>{t('previous')}</Button><Button size="sm" variant="flat" isDisabled={nextOffset === null} onPress={() => nextOffset !== null && go(nextOffset)}>{t('next')}</Button></div></div>;
}
export function ParameterFields({ descriptor, parameters, onChange, secrets = [], disabled }: { descriptor: SubscriptionDescriptor; parameters: Record<string, string | number | boolean>; onChange: (value: Record<string, string | number | boolean>) => void; secrets?: string[]; disabled?: boolean }) {
  const t = useTranslations('admin.subscriptions');
  return <div className="grid gap-4 sm:grid-cols-2">{Object.entries(descriptor.inputs).map(([name, field]) => field.type === 'boolean' ? <Switch key={name} isSelected={Boolean(parameters[name] ?? field.default)} onValueChange={value => onChange({ ...parameters, [name]: value })} isDisabled={disabled}>{field.label || name}</Switch> : field.type === 'enum' ? <Select key={name} label={field.label || name} selectedKeys={parameters[name] !== undefined || field.default !== undefined ? [String(parameters[name] ?? field.default)] : []} isDisabled={disabled} onChange={event => onChange({ ...parameters, [name]: event.target.value })}>{(field.options ?? []).map(option => <SelectItem key={option}>{option}</SelectItem>)}</Select> : <Input key={name} label={field.label || name} description={field.type === 'secret' && secrets.includes(name) ? t('secretSaved') : field.description} type={field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'} isRequired={field.required && !secrets.includes(name)} autoComplete="off" value={String(parameters[name] ?? field.default ?? '')} isDisabled={disabled} onValueChange={value => { const next = { ...parameters }; if (field.type === 'secret' && !value && secrets.includes(name)) delete next[name]; else next[name] = field.type === 'number' ? Number(value) : value; onChange(next); }} />)}</div>;
}
export function useDraftWarning(dirty: boolean) {
  const t = useTranslations('admin.subscriptions'), allow = useRef(false);
  const blocker = useBlocker(() => dirty && !allow.current);
  useEffect(() => { if (blocker.state === 'blocked') { if (window.confirm(t('discardDraft'))) blocker.proceed(); else blocker.reset(); } }, [blocker, t]);
  useEffect(() => { if (!dirty) return; const warn = (event: BeforeUnloadEvent) => { if (allow.current) return; event.preventDefault(); event.returnValue = ''; }; window.addEventListener('beforeunload', warn); return () => window.removeEventListener('beforeunload', warn); }, [dirty]);
  return () => { allow.current = true; };
}
export function CategorySwitch({ value, onChange, all = false }: { value: string; onChange: (value: string) => void; all?: boolean }) {
  const t = useTranslations('admin.subscriptions');
  return <div className="flex gap-1" role="group" aria-label={t('category')}>{(all ? ['all', 'website', 'model'] : ['website', 'model']).map(category => <Button key={category} size="sm" variant={value === category ? 'flat' : 'light'} color={value === category ? 'primary' : 'default'} aria-pressed={value === category} onPress={() => onChange(category)}>{t(category)}</Button>)}</div>;
}
export function DetailTabs({ id, active }: { id: string; active: string }) {
  const t = useTranslations('admin.subscriptions');
  return <nav className="mb-5 flex flex-wrap gap-5 border-b border-divider">{['items', 'runs', 'config', 'settings'].map(tab => <Link key={tab} to={`/admin/subscriptions/${id}${tab === 'config' ? '/config' : `?tab=${tab}`}`} className={`border-b-2 pb-3 text-small ${tab === active ? 'border-primary text-primary' : 'border-transparent text-default-500'}`}>{t(tab)}</Link>)}</nav>;
}
export function FieldGroup({ title, children }: { title: string; children: ReactNode }) { return <section className="space-y-4"><h2 className="text-medium font-semibold">{title}</h2>{children}</section>; }
