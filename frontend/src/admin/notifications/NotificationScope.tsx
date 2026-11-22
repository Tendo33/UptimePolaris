import clsx from 'clsx';
import { Check } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { NOTIFICATION_EVENT_KINDS, type NotificationRoutingScope } from '../../../../shared/notification-policy';

export type ChannelScope = Pick<NotificationRoutingScope, 'event_kinds' | 'source_types'>;
export const defaultChannelScope = (): ChannelScope => ({ event_kinds: ['monitor_state', 'ai_state', 'agent_resource'], source_types: ['local'] });

/** Toggle chips for a small fixed set of values. / 用于少量固定选项的切换标签。 */
function ChipSet<T extends string>({ label, values, value, onChange, text, disabled }: { label: string; values: readonly T[]; value: T[]; onChange: (next: T[]) => void; text: (value: T) => string; disabled?: boolean }) {
  return (
    <div>
      <p className="mb-2 text-[12.5px] font-medium text-[var(--polaris-ink-2)]">{label}</p>
      <div role="group" aria-label={label} className="flex flex-wrap gap-1.5">
        {values.map(option => {
          const on = value.includes(option);
          return (
            <button
              key={option}
              type="button"
              aria-pressed={on}
              disabled={disabled}
              onClick={() => onChange(on ? value.filter(item => item !== option) : [...value, option])}
              className={clsx(
                'inline-flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[12.5px] font-medium transition-colors disabled:opacity-50',
                on ? 'border-[var(--polaris-ink)] bg-[var(--polaris-ink)] text-[var(--polaris-card)]' : 'border-[var(--polaris-line)] text-[var(--polaris-ink-2)] hover:bg-[var(--polaris-hover)]',
              )}
            >
              {on ? <Check size={13} strokeWidth={2.5} aria-hidden="true" /> : null}
              {text(option)}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function NotificationScope({ value, onChange, disabled }: { value: ChannelScope; onChange: (scope: ChannelScope) => void; disabled?: boolean }) {
  const t = useTranslations('admin.notificationPolicy');
  const empty = !value.event_kinds?.length || !value.source_types?.length;

  return (
    <section className="space-y-4 rounded-xl border border-[var(--polaris-line)] p-4">
      <div>
        <h3 className="text-[13.5px] font-semibold text-[var(--polaris-ink)]">{t('scope')}</h3>
        <p className="mt-0.5 text-[12px] leading-relaxed text-[var(--polaris-ink-3)]">{t('scopeHint')}</p>
      </div>
      <ChipSet label={t('eventKinds')} values={NOTIFICATION_EVENT_KINDS} value={(value.event_kinds ?? []) as (typeof NOTIFICATION_EVENT_KINDS)[number][]} disabled={disabled} text={kind => t(`events.${kind}`)} onChange={next => onChange({ ...value, event_kinds: next as ChannelScope['event_kinds'] })} />
      <ChipSet label={t('sources')} values={['local', 'subscription'] as const} value={(value.source_types ?? []) as ('local' | 'subscription')[]} disabled={disabled} text={kind => t(`sourcesValue.${kind}`)} onChange={next => onChange({ ...value, source_types: next as ChannelScope['source_types'] })} />
      {empty ? <p role="status" className="text-[12px] text-warning-700">{t('emptyScope')}</p> : null}
    </section>
  );
}
