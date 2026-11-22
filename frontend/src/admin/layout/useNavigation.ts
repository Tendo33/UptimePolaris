import { useMemo } from 'react';
import { usePresentation } from '../settings/presentation-api';
import { NAV } from './nav';

export function useNavigation() {
  const config = usePresentation().data?.config;
  const aiEnabled = config?.aiEnabled === true;
  const agentsEnabled = config?.agentEnabled === true;
  return useMemo(() => NAV.filter((entry) => (entry.href !== '/admin/ai' || aiEnabled) && (entry.href !== '/admin/agents' || agentsEnabled)), [aiEnabled, agentsEnabled]);
}
