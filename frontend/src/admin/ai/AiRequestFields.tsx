import { Segmented } from '@/components/ui/Segmented';
import { Button, Input, Textarea } from '@heroui/react';
import { Plus, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { useTranslations } from 'use-intl';
import { parseAiBody, parseAiHeaders } from '../../../../shared/ai-request';

interface HeaderRow { key: number; name: string; value: string }

function objectFromJson(text: string): Record<string, unknown> | null {
  try { return parseAiBody(JSON.parse(text)); } catch { return null; }
}

export function HeadersEditor({ initialValue, disabled, onChange }: { initialValue: string; disabled: boolean; onChange: (text: string, valid: boolean) => void }) {
  const t = useTranslations('admin.ai');
  const [mode, setMode] = useState('fields');
  const [json, setJson] = useState(initialValue);
  const next = useRef(0);
  const toRows = (headers: Record<string, string>) => Object.entries(headers).map(([name, value]) => ({ key: next.current++, name, value }));
  const [rows, setRows] = useState<HeaderRow[]>(() => toRows(JSON.parse(initialValue)));
  const [invalid, setInvalid] = useState(false);
  const parse = (text: string) => {
    const value = objectFromJson(text);
    return value ? parseAiHeaders(value) : null;
  };
  const updateRows = (nextRows: HeaderRow[]) => {
    setRows(nextRows);
    const filled = nextRows.filter(row => row.name.trim() || row.value);
    const headers = Object.fromEntries(filled.map(row => [row.name.trim(), row.value]));
    const valid = filled.every(row => row.name.trim()) && filled.length === Object.keys(headers).length && parseAiHeaders(headers) !== null;
    const text = JSON.stringify(headers, null, 2);
    setJson(text);
    setInvalid(!valid);
    onChange(text, valid);
  };
  const changeMode = (value: string) => {
    const headers = parse(json);
    if (!headers || invalid) { setInvalid(true); return; }
    if (value === 'fields') setRows(toRows(headers));
    setMode(value);
  };
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <Segmented label={t('headerEditorMode')} className="self-start" value={mode} onChange={value => !disabled && changeMode(value)} options={[{ value: 'fields', label: t('headerFields') }, { value: 'json', label: 'JSON' }]} />
      {mode === 'fields' ? (
        <div className="flex flex-col gap-2">
          {!rows.length ? <p className="text-[12.5px] text-[var(--polaris-ink-3)]">{t('headersEmpty')}</p> : null}
          {rows.map((row, index) => (
            <div key={row.key} className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(0,3fr)_2.25rem] items-start gap-2">
              <Input aria-label={`${t('headerName')} ${index + 1}`} placeholder={t('headerName')} size="sm" value={row.name} onValueChange={name => updateRows(rows.map(item => item.key === row.key ? { ...item, name } : item))} maxLength={64} isDisabled={disabled} autoComplete="off" spellCheck="false" classNames={{ input: 'font-mono text-[12.5px]', inputWrapper: 'h-9 min-h-9' }} />
              <Input aria-label={`${t('headerValue')} ${index + 1}`} placeholder={t('headerValue')} size="sm" value={row.value} onValueChange={value => updateRows(rows.map(item => item.key === row.key ? { ...item, value } : item))} maxLength={2048} isDisabled={disabled} autoComplete="off" spellCheck="false" classNames={{ input: 'font-mono text-[12.5px]', inputWrapper: 'h-9 min-h-9' }} />
              <Button type="button" size="sm" isIconOnly variant="light" isDisabled={disabled} aria-label={t('removeHeader', { name: row.name || index + 1 })} onPress={() => updateRows(rows.filter(item => item.key !== row.key))} className="h-9 w-9 min-w-9 text-[var(--polaris-ink-3)]"><X size={16} /></Button>
            </div>
          ))}
          <Button type="button" size="sm" variant="light" isDisabled={disabled} startContent={<Plus size={14} />} onPress={() => updateRows([...rows, { key: next.current++, name: '', value: '' }])} className="self-start">{t('addHeader')}</Button>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <Textarea aria-label={t('headers')} value={json} onValueChange={text => { setJson(text); const valid = parse(text) !== null; setInvalid(!valid); onChange(text, valid); }} isDisabled={disabled} spellCheck="false" minRows={6} maxRows={16} classNames={{ input: 'font-mono text-[13px] leading-6' }} isInvalid={invalid} />
          <Button type="button" size="sm" variant="light" className="self-start" isDisabled={disabled || invalid} onPress={() => { const headers = parse(json); if (headers) { const text = JSON.stringify(headers, null, 2); setJson(text); onChange(text, true); } }}>{t('formatJson')}</Button>
        </div>
      )}
      {invalid ? <p role="alert" className="text-[12px] text-danger">{t('errors.invalid_ai_headers')}</p> : null}
      <p className="text-[12px] leading-5 text-[var(--polaris-ink-3)]">{t('headersEditableHint')}</p>
    </div>
  );
}

export function RequestBodyEditor({ value, onChange, disabled }: { value: string; onChange: (value: string) => void; disabled: boolean }) {
  const t = useTranslations('admin.ai');
  const valid = objectFromJson(value) !== null;
  return (
    <div className="flex flex-col gap-2">
      <Textarea name="requestBody" label={t('customBody')} description={t('customBodyHint')} value={value} onValueChange={onChange} minRows={6} maxRows={18} isDisabled={disabled} spellCheck="false" isInvalid={!valid} errorMessage={t('invalidJsonObject')} classNames={{ input: 'font-mono text-[13px] leading-6' }} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="light" isDisabled={disabled || !valid} onPress={() => { const body = objectFromJson(value); if (body) onChange(JSON.stringify(body, null, 2)); }}>{t('formatJson')}</Button>
        <Button type="button" size="sm" variant="light" isDisabled={disabled} onPress={() => onChange('{}')}>{t('clearBody')}</Button>
      </div>
    </div>
  );
}
