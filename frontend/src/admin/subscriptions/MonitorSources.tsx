import { Button } from '@heroui/react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import type { SubscriptionCategory } from '../../../../shared/subscriptions';

export function MonitorSources({ category, active }: { category: SubscriptionCategory; active: 'local' | 'subscription' }) {
  const t = useTranslations('admin.notificationPolicy.sourcesValue');
  return <nav className="mb-4 flex gap-2" aria-label={t('subscription')}><Button as={Link} to={category === 'website' ? '/admin' : '/admin/ai'} size="sm" variant={active === 'local' ? 'flat' : 'light'} aria-current={active === 'local' ? 'page' : undefined}>{t('local')}</Button><Button as={Link} to={`/admin/subscriptions?category=${category}`} size="sm" variant={active === 'subscription' ? 'flat' : 'light'} aria-current={active === 'subscription' ? 'page' : undefined}>{t('subscription')}</Button></nav>;
}
