import { useMemo } from 'react';
import { usePresentation } from '../settings/presentation-api';
import { NAV } from './nav';

/** The console entries this deployment shows; AI appears only while the feature is on. / 当前部署显示的控制台入口；AI 仅在功能开启时出现。 */
export function useNavigation() {
  const aiEnabled = usePresentation().data?.config.aiEnabled === true;
  return useMemo(() => NAV.filter((entry) => entry.href !== '/admin/ai' || aiEnabled), [aiEnabled]);
}
