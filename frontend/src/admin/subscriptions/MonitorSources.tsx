import clsx from 'clsx';
import { HardDrive, Rss } from 'lucide-react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import type { SubscriptionCategory } from '../../../../shared/subscriptions';

/** Switch between the local monitors of a kind and the subscribed ones. / 在本地监控与外部订阅之间切换。 */
export function MonitorSources({ category, active }: { category: SubscriptionCategory; active: 'local' | 'subscription' }) {
  const t = useTranslations('admin.notificationPolicy.sourcesValue');
  const links = [
    { key: 'local', to: category === 'website' ? '/admin' : '/admin/ai', icon: HardDrive },
    { key: 'subscription', to: `/admin/subscriptions?category=${category}`, icon: Rss },
  ] as const;
  return (
    <nav aria-label={t('subscription')} className="mb-4 inline-flex self-start rounded-[10px] border border-[var(--polaris-line)] bg-[var(--polaris-well)] p-0.5">
      {links.map(({ key, to, icon: Icon }) => (
        <Link
          key={key}
          to={to}
          aria-current={active === key ? 'page' : undefined}
          className={clsx(
            'inline-flex h-7 items-center gap-1.5 rounded-lg px-3 text-[12.5px] font-medium transition-colors',
            active === key ? 'bg-[var(--polaris-card)] text-[var(--polaris-ink)] shadow-[0_1px_2px_rgb(0_0_0/0.06)] ring-1 ring-[var(--polaris-line)]' : 'text-[var(--polaris-ink-3)] hover:text-[var(--polaris-ink)]',
          )}
        >
          <Icon size={13} aria-hidden="true" />
          {t(key)}
        </Link>
      ))}
    </nav>
  );
}
