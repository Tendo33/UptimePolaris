import { SubscriptionError, type SubscriptionIssue, type SubscriptionSourceItem } from './subscriptions';

export function redactSubscriptionIssues(issues: SubscriptionIssue[], parameters: Record<string, unknown>): SubscriptionIssue[] {
  const secrets = Object.values(parameters).filter((value): value is string => typeof value === 'string' && !!value).flatMap(value => [value, encodeURIComponent(value)]);
  return issues.map(issue => ({ ...issue, ...(issue.itemId && secrets.some(secret => issue.itemId!.includes(secret)) ? { itemId: '[redacted]' } : {}) }));
}

export function redactSubscriptionItems<T extends SubscriptionSourceItem>(items: T[], parameters: Record<string, unknown>): T[] {
  const secrets = [...new Set(Object.values(parameters).filter((value): value is string => typeof value === 'string' && !!value).flatMap(value => [value, encodeURIComponent(value)]))].sort((a,b) => b.length - a.length);
  const clean = (value: string | null) => value === null ? null : secrets.reduce((text, secret) => text.split(secret).join('[redacted]'), value);
  return items.map(item => {
    if (secrets.some(secret => item.sourceItemId.includes(secret))) throw new SubscriptionError('subscription_sensitive_identity');
    const observation = (point: NonNullable<T['observation']>) => ({ ...point, reason: clean(point.reason) });
    let url = item.url;
    if (url) { const parsed = new URL(url); parsed.username = ''; parsed.password = ''; parsed.search = ''; parsed.hash = ''; url = clean(parsed.href); }
    return { ...item, name: clean(item.name)!, group: clean(item.group), modelId: clean(item.modelId), provider: clean(item.provider), protocol: clean(item.protocol), url,
      observation: item.observation ? observation(item.observation) : null, recent: item.recent.map(observation) };
  });
}
