import { Select } from '@/components/ui/MotionOverlays';
import { Button, SelectItem } from '@heroui/react';
import { Link } from 'react-router';
import useSWR from 'swr';
import { useTranslations } from 'use-intl';
import { notificationsApi } from './api';

export function NotificationPicker({ value, onChange, disabled = false }: { value: string[]; onChange: (ids: string[]) => void; disabled?: boolean }) {
  const t = useTranslations('admin.notificationRouting');
  const resource = useSWR('console:notification-picker', notificationsApi.listNotifications, { revalidateOnFocus: false, shouldRetryOnError: false });
  const options = (resource.data?.channels ?? []).map(channel => ({ id: channel.id, name: channel.name, active: Boolean(channel.active) }));
  for (const id of value) if (!options.some(option => option.id === id)) options.push({ id, name: resource.data ? t('missing') : id, active: false });
  return (
    <div className="flex flex-col gap-2">
      <Select
        label={t('label')}
        placeholder={t('global')}
        description={t('hint')}
        selectionMode="multiple"
        selectedKeys={value}
        isLoading={resource.isLoading}
        isDisabled={disabled || !resource.data || Boolean(resource.error)}
        onSelectionChange={keys => { if (keys !== 'all') onChange(Array.from(keys, String)); }}
      >
        {options.map(option => <SelectItem key={option.id} textValue={option.name}>{option.name}{!option.active ? ` · ${t('inactive')}` : ''}</SelectItem>)}
      </Select>
      {resource.error ? (
        <div role="alert" className="flex flex-wrap items-center gap-2 text-small text-danger">
          <span>{t('failed')}</span>
          <Button size="sm" variant="light" isDisabled={disabled} onPress={() => void resource.mutate().catch(() => undefined)}>{t('retry')}</Button>
        </div>
      ) : resource.data?.channels.length === 0 ? <Link to="/admin/notifications" className="self-start text-small underline underline-offset-4">{t('create')}</Link> : null}
      {value.length > 0 ? <Button size="sm" variant="light" className="self-start" isDisabled={disabled} onPress={() => onChange([])}>{t('restore')}</Button> : null}
    </div>
  );
}
