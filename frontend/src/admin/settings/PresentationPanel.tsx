import { MotionDisclosure } from '@/components/ui/MotionDisclosure';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { Button, Input, Skeleton, Switch } from '@heroui/react';
import clsx from 'clsx';
import { ArrowRight, Bot, ExternalLink, Globe, Info, Monitor, Palette, Plus, Server, Trash2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useTranslations } from 'use-intl';
import { normalizeDomain, type DomainPage, type PageKind, type PresentationConfig } from '../../../../shared/presentation';
import { PUBLIC_PAGE_PATHS } from '../../../../shared/public-page-paths';
import { IconTile } from '../components/IconTile';
import { AutoSaveStatus, useAutoSave } from '../useAutoSave';
import { updatePresentation, usePresentation } from './presentation-api';

type DomainDraft = DomainPage & { emptyDraft?: boolean };
type Switches = Pick<PresentationConfig, 'agentEnabled' | 'aiEnabled' | 'aiOnMonitorPage'>;
type Patch = Partial<Switches & { domains: DomainPage[] }>;

const ICON: Record<PageKind, ReactNode> = { monitor: <Monitor />, agent: <Server />, ai: <Bot /> };
const PATH = PUBLIC_PAGE_PATHS;

/**
 * One card per public page: whether it is on, where visitors find it, which
 * theme it wears and which domains point at it. Domains only take effect once a
 * second page is on, so the monitor page's domains wait until then.
 *
 * 每个公开页面一张卡片：是否开启、访客从哪里访问、使用的主题以及绑定的域名。
 * 只有开启第二个页面后域名映射才生效，因此监控页的域名在此之前不显示输入框。
 */
export function PresentationPanel() {
  const t = useTranslations('admin.presentation');
  const message = useApiErrorMessage();
  const data = usePresentation();
  const [switches, setSwitches] = useState<Switches | null>(null);
  const [domains, setDomains] = useState<DomainDraft[]>([]);
  const [invalid, setInvalid] = useState(false);
  const save = useAutoSave<Patch>((patch) => updatePresentation((config) => ({ ...config, ...patch })));

  useEffect(() => {
    if (switches === null && data.data) {
      const { agentEnabled, aiEnabled, aiOnMonitorPage, domains: saved } = data.data.config;
      setSwitches({ agentEnabled, aiEnabled, aiOnMonitorPage });
      setDomains(saved);
    }
  }, [data.data, switches]);

  if (data.error)
    return (
      <div role="alert" className="flex flex-wrap items-center gap-2 text-small text-danger">
        <span>{message(data.error)}</span>
        <Button size="sm" variant="light" onPress={() => void data.mutate()}>
          {t('retry')}
        </Button>
      </div>
    );
  if (switches === null || !data.data) return <Skeleton className="h-64 rounded-xl" />;

  const pages = data.data.config.pages;
  const mapping = switches.agentEnabled || switches.aiEnabled;
  const bound = domains.some((row) => row.hostname.trim());

  const toggle = (patch: Partial<Switches>) => {
    setSwitches({ ...switches, ...patch });
    save.schedule(patch, true);
  };

  function changeDomains(next: DomainDraft[], showError = false) {
    setDomains(next);
    const seen = new Set<string>();
    const normalized: DomainPage[] = [];
    for (const row of next) {
      if (row.emptyDraft && !row.hostname) continue;
      const hostname = normalizeDomain(row.hostname);
      if (!hostname || seen.has(hostname)) {
        save.cancel('domains');
        if (showError) setInvalid(true);
        return;
      }
      seen.add(hostname);
      normalized.push({ hostname, page: row.page });
    }
    setInvalid(false);
    save.schedule({ domains: normalized });
  }

  const domainEditor = (kind: PageKind) => (
    <DomainList
      rows={domains}
      kind={kind}
      onChange={changeDomains}
      onBlur={() => {
        changeDomains(domains, true);
        void save.flush();
      }}
      onAdd={() => setDomains([...domains, { hostname: '', page: kind, emptyDraft: true }])}
    />
  );

  return (
    <div className="flex flex-col gap-4">
      <PageCard
        kind="monitor"
        title={t('monitorPage')}
        hint={t('monitorPageHint')}
        state={<span className="inline-flex h-6 items-center rounded-full border border-[var(--polaris-line)] px-2.5 text-[12px] text-[var(--polaris-ink-3)]">{t('alwaysOn')}</span>}
        open
        theme={pages.monitor.theme?.short ?? null}
      >
        {mapping ? <Row label={t('domainsLabel')}>{domainEditor('monitor')}</Row> : <Row label={t('domainsLabel')}><p className="text-[12.5px] leading-5 text-[var(--polaris-ink-3)]">{t('domainsLocked')}</p></Row>}
      </PageCard>

      <PageCard
        kind="agent"
        title={t('agentPage')}
        hint={t('enableAgentsHint')}
        state={<Switch size="sm" aria-label={t('enableAgents')} isSelected={switches.agentEnabled} onValueChange={(value) => toggle({ agentEnabled: value })} />}
        open={switches.agentEnabled}
        theme={pages.agent.theme?.short ?? null}
      >
        <Row label={t('domainsLabel')}>{domainEditor('agent')}</Row>
      </PageCard>

      <PageCard
        kind="ai"
        title={t('aiPage')}
        hint={t('aiPageHint')}
        state={<Switch size="sm" aria-label={t('enableAi')} isSelected={switches.aiEnabled} onValueChange={(value) => toggle({ aiEnabled: value })} />}
        open={switches.aiEnabled}
        theme={pages.ai.theme?.short ?? null}
        extra={
          <Button as={Link} to="/admin/ai" size="sm" variant="light" endContent={<ArrowRight size={13} />} className="h-7 px-2 text-[12.5px]">
            {t('manageAi')}
          </Button>
        }
      >
        <Row label={t('aiOnMonitor')}>
          <div className="flex items-start gap-3">
            <Switch size="sm" aria-label={t('aiOnMonitor')} isSelected={switches.aiOnMonitorPage} onValueChange={(value) => toggle({ aiOnMonitorPage: value })} />
            <p className="text-[12.5px] leading-5 text-[var(--polaris-ink-3)]">{t('aiOnMonitorHint')}</p>
          </div>
        </Row>
        <Row label={t('domainsLabel')}>{domainEditor('ai')}</Row>
      </PageCard>

      {invalid ? (
        <p role="alert" className="text-small text-danger">
          {t('invalidDomains')}
        </p>
      ) : null}
      {mapping ? (
        <p className={clsx('flex items-start gap-2 rounded-xl px-3.5 py-2.5 text-[12.5px] leading-5', bound ? 'border border-warning/30 bg-warning/[0.06] text-warning-700' : 'bg-[var(--polaris-well)] text-[var(--polaris-ink-3)]')}>
          <Info size={14} className="mt-[3px] shrink-0" />
          {t('domainsHint')}
        </p>
      ) : null}
      <AutoSaveStatus {...save} />
    </div>
  );
}

function PageCard({
  kind,
  title,
  hint,
  state,
  open,
  theme,
  extra,
  children,
}: {
  kind: PageKind;
  title: string;
  hint: string;
  state: ReactNode;
  open: boolean;
  theme: string | null;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const t = useTranslations('admin.presentation');
  const path = PATH[kind];
  return (
    <section aria-label={title} className={clsx('rounded-xl border bg-[var(--polaris-card)] transition-colors', open ? 'border-[var(--polaris-line)]' : 'border-[var(--polaris-line-soft)]')}>
      <div className="flex items-start gap-3 px-4 py-3.5">
        <IconTile icon={ICON[kind]} size="md" className={clsx(!open && 'opacity-60')} />
        <div className="min-w-0 flex-1">
          <h3 className={clsx('text-[14px] font-semibold', open ? 'text-[var(--polaris-ink)]' : 'text-[var(--polaris-ink-2)]')}>{title}</h3>
          <p className="mt-0.5 text-[12.5px] leading-5 text-[var(--polaris-ink-3)]">{hint}</p>
        </div>
        <div className="shrink-0 pt-0.5">{state}</div>
      </div>
      <MotionDisclosure open={open} className="flex flex-col gap-3 border-t border-[var(--polaris-line-soft)] px-4 py-3.5">
        <Row label={t('addressLabel')}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <a href={path} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-mono text-[12.5px] text-[var(--polaris-ink)] underline decoration-[var(--polaris-line-strong)] underline-offset-4 hover:decoration-current">
              {path}
              <ExternalLink size={12} className="text-[var(--polaris-ink-4)]" />
            </a>
            {extra}
          </div>
        </Row>
        <Row label={t('theme')}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="text-[12.5px] text-[var(--polaris-ink)]">{theme ?? t('builtIn')}</span>
            <Button as={Link} to="/admin/themes" size="sm" variant="light" startContent={<Palette size={13} />} className="h-7 px-2 text-[12.5px]">
              {t('configureLook')}
            </Button>
          </div>
        </Row>
        {children}
      </MotionDisclosure>
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-[8.5rem_minmax(0,1fr)] sm:items-start">
      <span className="pt-1 text-[12.5px] text-[var(--polaris-ink-3)]">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function DomainList({ rows, kind, onChange, onBlur, onAdd }: { rows: DomainDraft[]; kind: PageKind; onChange: (rows: DomainDraft[], showError?: boolean) => void; onBlur: () => void; onAdd: () => void }) {
  const t = useTranslations('admin.presentation');
  const own = rows.map((row, index) => ({ row, index })).filter(({ row }) => row.page === kind);
  return (
    <div className="flex flex-col gap-2">
      {own.map(({ row, index }) => {
        const host = normalizeDomain(row.hostname);
        return (
          <div key={index} className="flex items-center gap-1.5">
            <Input
              size="sm"
              variant="bordered"
              aria-label={t('hostname')}
              placeholder="status.example.com"
              startContent={<Globe size={14} className="shrink-0 text-[var(--polaris-ink-4)]" />}
              value={row.hostname}
              classNames={{ input: 'font-mono text-[12.5px]' }}
              className="max-w-sm"
              onValueChange={(hostname) => onChange(rows.map((item, i) => (i === index ? { ...item, hostname, emptyDraft: item.emptyDraft && !hostname } : item)))}
              onBlur={onBlur}
            />
            {host ? (
              <Button as="a" href={`https://${host}`} target="_blank" rel="noopener noreferrer" isIconOnly size="sm" variant="light" aria-label={t('openDomain', { host })} className="text-[var(--polaris-ink-3)]">
                <ExternalLink size={14} />
              </Button>
            ) : null}
            <Button isIconOnly size="sm" variant="light" color="danger" aria-label={t('remove')} onPress={() => onChange(rows.filter((_, i) => i !== index), true)}>
              <Trash2 size={14} />
            </Button>
          </div>
        );
      })}
      <div>
        <Button size="sm" variant="light" startContent={<Plus size={14} />} onPress={onAdd} className="h-7 px-2 text-[12.5px]">
          {t('addDomain')}
        </Button>
      </div>
    </div>
  );
}
