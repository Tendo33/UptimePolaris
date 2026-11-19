import { useState } from 'react';
import { Button, Skeleton } from '@heroui/react';
import { Bot, Eye, Monitor, RotateCcw, Server, Settings2 } from 'lucide-react';
import { useTranslations } from 'use-intl';
import { useApiErrorMessage } from '@/api/useApiErrorMessage';
import { builtinThemeOptions } from '../../../../shared/builtin-theme';
import type {
  PageKind,
  PageSettings,
} from '../../../../shared/presentation';
import { usePresentation } from '../settings/presentation-api';
import { Panel, PanelHeader } from '../components/Panel';
import { ThemeEditor } from './ThemeEditor';
import type { InstalledTheme, ThemeDefinition } from './types';

// 页面选版、启用状态与选项分别保存；冲突更新由展示配置接口处理。
// Save theme selection, enabled state, and options separately through the presentation configuration API.
export function PageThemes({
  themes,
  busy,
  onReset,
  onPreview,
}: {
  themes: InstalledTheme[];
  busy: boolean;
  onReset: (kind: PageKind) => void;
  onPreview: (short: string, version: string, theme: string) => void;
}) {
  const t = useTranslations('admin.themes'),
    p = useTranslations('admin.presentation'),
    message = useApiErrorMessage();
  const data = usePresentation();
  const [editing, setEditing] = useState<{
    kind: PageKind;
    page: PageSettings;
    definition: ThemeDefinition;
  } | null>(null);
  if (data.error)
    return (
      <Panel>
        <p role="alert" className="text-small text-danger">
          {message(data.error)}
        </p>
        <Button size="sm" variant="light" onPress={() => void data.mutate()}>
          {p('retry')}
        </Button>
      </Panel>
    );
  if (!data.data) return <Skeleton className="h-44 rounded-xl" />;
  const kinds: PageKind[] = ['monitor', ...(data.data.config.agentEnabled ? ['agent' as const] : []), ...(data.data.config.aiEnabled ? ['ai' as const] : [])];
  return (
    <>
      <div
        className={
          'grid grid-cols-1 gap-4 ' +
          (kinds.length === 3
            ? 'lg:grid-cols-2 xl:grid-cols-3'
            : kinds.length === 2 ? 'lg:grid-cols-2' : '')
        }
      >
        {kinds.map((kind) => {
          const page = data.data!.config.pages[kind];
          const theme = themes.find(
            (theme) => theme.short === page.theme?.short,
          );
          const version = theme?.versions.find(
            (version) => version.versionKey === page.theme?.version,
          );
          const installedDefinition = version?.themes.find(
            (definition) =>
              definition.id === page.theme?.theme && definition.target === kind,
          );
          const definition: ThemeDefinition | undefined = page.theme ? installedDefinition : {
            id: kind, name: p('builtIn'), target: kind, entry: '', capabilities: [], available: true,
            options: builtinThemeOptions(kind).map((option) => ({
              ...option,
              label: t(`builtinOptions.${option.key}`),
              choiceLabels: option.choices ? Object.fromEntries(option.choices.map((choice) => [choice, t(`builtinChoices.${choice}`)])) : undefined,
            })),
          };
          const Icon = kind === 'monitor' ? Monitor : kind === 'ai' ? Bot : Server;
          return (
            <Panel key={kind}>
              <PanelHeader
                icon={<Icon />}
                title={t(kind === 'monitor' ? 'monitorBoard' : kind === 'ai' ? 'aiBoard' : 'serverBoard')}
              />
              <div className="flex min-h-20 flex-col justify-center gap-1">
                <h3 className="break-words text-lg font-semibold text-[var(--polaris-ink)]">
                  {page.theme
                    ? (theme?.name ?? page.theme.short)
                    : p('builtIn')}
                </h3>
                <p className="break-words text-small text-default-500">
                  {page.theme
                    ? [
                        definition?.name ?? page.theme.theme,
                        version?.version ?? page.theme.version,
                      ].join(' · ')
                    : t('builtInHint')}
                </p>
                {page.theme && !definition?.available ? (
                  <p role="status" className="text-small text-warning-700">
                    {t('unsupported')}
                  </p>
                ) : null}
              </div>
              <div className="mt-4 flex flex-wrap gap-2 border-t border-[var(--polaris-line-soft)] pt-4">
                {page.theme ? (
                  <Button
                    size="sm"
                    variant="flat"
                    startContent={<Eye size={14} />}
                    isDisabled={busy || !definition?.available}
                    onPress={() =>
                      onPreview(
                        page.theme!.short,
                        page.theme!.version,
                        page.theme!.theme,
                      )
                    }
                  >
                    {t('previewPage')}
                  </Button>
                ) : (
                  <Button
                    as="a"
                    size="sm"
                    variant="flat"
                    href={'/?preview=' + kind}
                    target="_blank"
                    rel="noopener noreferrer"
                    startContent={<Eye size={14} />}
                  >
                    {t('previewPage')}
                  </Button>
                )}
                {definition?.available ? (
                  <Button
                    size="sm"
                    variant="bordered"
                    className="font-medium"
                    startContent={<Settings2 size={14} />}
                    isDisabled={busy}
                    onPress={() => setEditing({ kind, page, definition })}
                  >
                    {t('configure')}
                  </Button>
                ) : null}
                {page.theme ? (
                  <Button
                    size="sm"
                    variant="light"
                    startContent={<RotateCcw size={14} />}
                    isDisabled={busy}
                    onPress={() => onReset(kind)}
                  >
                    {t('restoreBuiltIn')}
                  </Button>
                ) : null}
              </div>
            </Panel>
          );
        })}
      </div>
      {editing ? (
        <ThemeEditor {...editing} onClose={() => setEditing(null)} />
      ) : null}
    </>
  );
}
