import { ApiError } from '@/api/errors';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { stateTone } from '@/components/subscriptions/observation';
import { Segmented } from '@/components/ui/Segmented';
import { usePresentation } from '../settings/presentation-api';
import { AdminPage } from '../layout/AdminPage';
import { StatusDot, TONE_TEXT } from '@/components/ui/StatusDot';
import { Select } from '@/components/ui/MotionOverlays';
import { Button, Input, SelectItem, Skeleton, Switch } from '@heroui/react';
import clsx from 'clsx';
import { AlertCircle, ChevronLeft, ChevronRight, Info, Lock, RotateCw } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { Link, NavLink, useBlocker, useSearchParams } from 'react-router';
import { useFormatter, useTranslations } from 'use-intl';
import type { Subscription, SubscriptionDescriptor } from '../../../../shared/subscriptions';

const TAB = 'relative -mb-px inline-flex h-10 items-center gap-1.5 border-b-2 px-0.5 text-[13px] font-medium transition-colors';
const TAB_ON = 'border-[var(--polaris-ink)] text-[var(--polaris-ink)]';
const TAB_OFF = 'border-transparent text-[var(--polaris-ink-3)] hover:text-[var(--polaris-ink)]';

export function SubscriptionContent({ embedded, children, actions, ...props }: Parameters<typeof AdminPage>[0] & { embedded?: boolean }) {
  return embedded ? <>{children}</> : <AdminPage {...props} actions={actions}>{children}</AdminPage>;
}

export function SubscriptionTabs({ counts }: { counts?: { mine?: number; library?: number } }) {
  const t = useTranslations('admin.subscriptions');
  return (
    <nav aria-label={t('title')} className="mb-5 flex gap-6 border-b border-[var(--polaris-line)]">
      {([['/admin/subscriptions', 'mine'], ['/admin/subscriptions/library', 'library']] as const).map(([to, key]) => (
        <NavLink end={key === 'mine'} key={to} to={to} className={({ isActive }) => clsx(TAB, isActive ? TAB_ON : TAB_OFF)}>
          {t(key)}
          {counts?.[key] !== undefined ? <span className="polaris-num rounded-full bg-[var(--polaris-well)] px-1.5 text-[12px] text-[var(--polaris-ink-3)]">{counts[key]}</span> : null}
        </NavLink>
      ))}
    </nav>
  );
}

export function useSubscriptionError() {
  const t = useTranslations('admin.subscriptions.errors');
  const fallback = useApiErrorMessage();
  return (error: unknown) => { const code = typeof error === 'string' ? error : error instanceof ApiError ? error.code : error instanceof Error ? error.message : ''; return error instanceof SyntaxError ? t('json') : code && t.has(code) ? t(code) : typeof error === 'string' ? error : fallback(error); };
}

export function Failure({ error, retry, className }: { error: unknown; retry?: () => void; className?: string }) {
  const describe = useSubscriptionError(), t = useTranslations('admin.subscriptions');
  if (!error) return null;
  return (
    <div role="alert" className={clsx('flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-danger/20 bg-danger/[0.05] px-4 py-3 text-[13px] text-danger-600', className ?? 'mb-4')}>
      <AlertCircle size={16} className="shrink-0" aria-hidden="true" />
      <span className="min-w-0 flex-1">{describe(error)}</span>
      {retry ? <Button size="sm" variant="flat" color="danger" startContent={<RotateCw size={13} />} onPress={retry}>{t('retry')}</Button> : null}
    </div>
  );
}

/** A quiet note, for hints that must be read before acting. / 操作前需要阅读的提示。 */
export function Note({ tone = 'info', children, className, align = 'start' }: { tone?: 'info' | 'warn'; children: ReactNode; className?: string; align?: 'start' | 'center' }) {
  return (
    <div className={clsx('flex gap-2.5 rounded-xl border px-3.5 py-3 text-[12.5px] leading-relaxed', align === 'center' ? 'items-center' : 'items-start', tone === 'warn' ? 'border-warning/30 bg-warning/[0.07] text-warning-800 dark:text-warning-600' : 'border-[var(--polaris-line)] bg-[var(--polaris-well)] text-[var(--polaris-ink-2)]', className)}>
      {tone === 'warn' ? <AlertCircle size={15} className={clsx('shrink-0', align === 'start' && 'mt-px')} aria-hidden="true" /> : <Info size={15} className={clsx('shrink-0 text-[var(--polaris-ink-4)]', align === 'start' && 'mt-px')} aria-hidden="true" />}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export function Loading({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" className="polaris-card divide-y divide-[var(--polaris-line-soft)] overflow-hidden">
      {Array.from({ length: rows }, (_, key) => (
        <div key={key} className="flex items-center gap-3 px-5 py-4">
          <Skeleton className="h-8 w-8 rounded-[9px]" />
          <div className="flex-1 space-y-2">
            <Skeleton className="h-3.5 w-2/5 rounded-md" />
            <Skeleton className="h-3 w-1/4 rounded-md" />
          </div>
          <Skeleton className="hidden h-5 w-40 rounded-md sm:block" />
        </div>
      ))}
    </div>
  );
}

export function Timestamp({ value }: { value: number | null | undefined }) {
  const format = useFormatter(), t = useTranslations('admin.subscriptions');
  if (!value) return <>{t('never')}</>;
  const date = new Date(value * 1000);
  return <time dateTime={date.toISOString()} title={format.dateTime(date, { dateStyle: 'medium', timeStyle: 'medium' })}>{format.dateTime(date, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</time>;
}

export function Status({ value, className }: { value: string; className?: string }) {
  const t = useTranslations('admin.subscriptions.status');
  const tone = stateTone(value);
  return (
    <span className={clsx('inline-flex items-center gap-1.5 text-[13px] font-medium', tone === 'idle' ? 'text-[var(--polaris-ink-3)]' : TONE_TEXT[tone], className)}>
      <StatusDot tone={tone} size={7} pulse={tone === 'pending'} />
      {t.has(value) ? t(value) : value}
    </span>
  );
}

/** A small rounded tag. / 小圆角标签。 */
export function Tag({ children, tone = 'default', className, title }: { children: ReactNode; tone?: 'default' | 'primary' | 'success' | 'warning' | 'danger'; className?: string; title?: string }) {
  return (
    <span
      title={title}
      className={clsx(
        'inline-flex h-[20px] shrink-0 items-center gap-1 rounded-md border px-1.5 text-[12px] font-medium whitespace-nowrap',
        tone === 'primary' && 'border-primary/20 bg-primary/[0.06] text-primary-600',
        tone === 'success' && 'border-success/25 bg-success/[0.07] text-success-700',
        tone === 'warning' && 'border-warning/30 bg-warning/[0.08] text-warning-700',
        tone === 'danger' && 'border-danger/20 bg-danger/[0.06] text-danger-600',
        tone === 'default' && 'border-[var(--polaris-line)] bg-[var(--polaris-well)] text-[var(--polaris-ink-2)]',
        className,
      )}
    >
      {children}
    </span>
  );
}

export { subscriptionHealth } from '../../../../shared/subscriptions';

export function Pagination({ total, nextOffset, pageSize = 50 }: { total: number; nextOffset: number | null; pageSize?: number }) {
  const t = useTranslations('admin.subscriptions'), [search, setSearch] = useSearchParams();
  const offset = Number(search.get('offset') ?? 0);
  const go = (value: number) => { const next = new URLSearchParams(search); next.set('offset', String(value)); setSearch(next); };
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.floor(offset / pageSize) + 1;
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-[var(--polaris-ink-3)]">
      <span className="polaris-num">{t('total', { count: total })}</span>
      {pages > 1 ? (
        <div className="ml-auto flex items-center gap-1">
          <Button size="sm" isIconOnly variant="light" aria-label={t('previousPage')} isDisabled={!offset} onPress={() => go(Math.max(0, offset - pageSize))}><ChevronLeft size={15} /></Button>
          <span className="polaris-num px-1">{t('pageOf', { page, pages })}</span>
          <Button size="sm" isIconOnly variant="light" aria-label={t('next')} isDisabled={nextOffset === null} onPress={() => nextOffset !== null && go(nextOffset)}><ChevronRight size={15} /></Button>
        </div>
      ) : null}
    </div>
  );
}

export function ParameterFields({ descriptor, parameters, onChange, secrets = [], disabled }: { descriptor: SubscriptionDescriptor; parameters: Record<string, string | number | boolean>; onChange: (value: Record<string, string | number | boolean>) => void; secrets?: string[]; disabled?: boolean }) {
  const t = useTranslations('admin.subscriptions');
  const entries = Object.entries(descriptor.inputs);
  if (!entries.length) return <p className="text-[13px] text-[var(--polaris-ink-3)]">{t('noParameters')}</p>;
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {entries.map(([name, field]) => field.type === 'boolean' ? (
        <SettingRow key={name} className="sm:col-span-2" title={field.label || name} hint={field.description}>
          <Switch size="sm" aria-label={field.label || name} isSelected={Boolean(parameters[name] ?? field.default)} onValueChange={value => onChange({ ...parameters, [name]: value })} isDisabled={disabled} />
        </SettingRow>
      ) : field.type === 'enum' ? (
        <Select key={name} label={field.label || name} labelPlacement="outside" placeholder={name} description={field.description} selectedKeys={parameters[name] !== undefined || field.default !== undefined ? [String(parameters[name] ?? field.default)] : []} isDisabled={disabled} onChange={event => onChange({ ...parameters, [name]: event.target.value })}>
          {(field.options ?? []).map(option => <SelectItem key={option}>{option}</SelectItem>)}
        </Select>
      ) : (
        <Input
          key={name}
          label={field.label || name}
          labelPlacement="outside"
          placeholder={field.type === 'secret' && secrets.includes(name) ? '••••••••' : field.type === 'url' ? 'https://' : String(field.default ?? '')}
          description={field.type === 'secret' && secrets.includes(name) ? t('secretSaved') : field.description}
          type={field.type === 'secret' ? 'password' : field.type === 'number' ? 'number' : field.type === 'url' ? 'url' : 'text'}
          isRequired={field.required && !secrets.includes(name)}
          autoComplete="off"
          startContent={field.type === 'secret' ? <Lock size={13} className="shrink-0 text-[var(--polaris-ink-4)]" /> : undefined}
          classNames={field.type === 'url' || field.type === 'secret' ? { input: 'font-mono text-[12.5px]' } : undefined}
          className={field.type === 'url' ? 'sm:col-span-2' : undefined}
          value={String(parameters[name] ?? field.default ?? '')}
          isDisabled={disabled}
          onValueChange={value => { const next = { ...parameters }; if (field.type === 'secret' && !value && secrets.includes(name)) delete next[name]; else next[name] = field.type === 'number' ? Number(value) : value; onChange(next); }}
        />
      ))}
    </div>
  );
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
  const config = usePresentation().data?.config;
  const aiEnabled = config?.aiEnabled === true;
  useEffect(() => { if (config && !aiEnabled && value === 'model') onChange(all ? 'all' : 'website'); }, [config, aiEnabled, value, all, onChange]);
  return <Segmented label={t('category')} value={!aiEnabled && value === 'model' ? all ? 'all' : 'website' : value} onChange={onChange} options={(all ? ['all', 'website', 'model'] : ['website', 'model']).filter(category => category !== 'model' || aiEnabled).map(category => ({ value: category, label: t(category) }))} />;
}

export function DetailTabs({ id, active, counts }: { id: string; active: string; counts?: Partial<Record<'items' | 'runs', number>> }) {
  const t = useTranslations('admin.subscriptions');
  return (
    <nav aria-label={t('title')} className="mb-5 flex flex-wrap gap-x-6 border-b border-[var(--polaris-line)]">
      {(['items', 'runs', 'config', 'settings'] as const).map(tab => (
        <Link key={tab} aria-current={tab === active ? 'page' : undefined} to={`/admin/subscriptions/${encodeURIComponent(id)}?tab=${tab}`} className={clsx(TAB, tab === active ? TAB_ON : TAB_OFF)}>
          {t(tab)}
          {tab !== 'config' && tab !== 'settings' && counts?.[tab] !== undefined ? <span className="polaris-num rounded-full bg-[var(--polaris-well)] px-1.5 text-[12px] text-[var(--polaris-ink-3)]">{counts[tab]}</span> : null}
        </Link>
      ))}
    </nav>
  );
}

/** A titled block in a framed card. / 带标题的卡片区块。 */
export function FieldGroup({ title, description, actions, icon, children, className }: { title: string; description?: ReactNode; actions?: ReactNode; icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={clsx('polaris-card p-5', className)}>
      <div className="mb-4 flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-[14px] leading-5 font-semibold tracking-[-0.01em] text-[var(--polaris-ink)]">
            {icon ? <span aria-hidden="true" className="inline-flex text-[var(--polaris-ink-4)] [&>svg]:h-[15px] [&>svg]:w-[15px]">{icon}</span> : null}
            {title}
          </h2>
          {description ? <p className="mt-0.5 text-[12.5px] leading-5 text-[var(--polaris-ink-3)]">{description}</p> : null}
        </div>
        {actions ? <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div className="space-y-4">{children}</div>
    </section>
  );
}

/** A label and hint on the left, a control on the right. / 左侧标题与说明，右侧控件。 */
export function SettingRow({ title, hint, children, className }: { title: ReactNode; hint?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={clsx('flex items-center gap-4 rounded-xl border border-[var(--polaris-line-soft)] px-4 py-3', className)}>
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium text-[var(--polaris-ink)]">{title}</p>
        {hint ? <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">{hint}</p> : null}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Interval quick picks under a seconds field. / 秒数输入下方的快捷间隔。 */
export function IntervalPresets({ value, onChange, options, disabled }: { value: number; onChange: (seconds: number) => void; options: number[]; disabled?: boolean }) {
  const label = useDuration();
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map(seconds => (
        <button
          key={seconds}
          type="button"
          disabled={disabled}
          aria-pressed={value === seconds}
          onClick={() => onChange(seconds)}
          className={clsx(
            'polaris-num h-7 rounded-lg border px-2.5 text-[12px] font-medium transition-colors disabled:opacity-50',
            value === seconds ? 'border-[var(--polaris-ink)] bg-[var(--polaris-ink)] text-[var(--polaris-card)]' : 'border-[var(--polaris-line)] text-[var(--polaris-ink-2)] hover:bg-[var(--polaris-hover)]',
          )}
        >
          {label(seconds)}
        </button>
      ))}
    </div>
  );
}

/** Seconds as a short duration, for intervals. / 将秒数显示为简短时长。 */
export function useDuration() {
  const t = useTranslations('admin.subscriptions');
  return (seconds: number) => seconds % 3600 === 0 ? t('hoursShort', { n: seconds / 3600 }) : seconds % 60 === 0 ? t('minutesShort', { n: seconds / 60 }) : t('secondsShort', { n: seconds });
}
