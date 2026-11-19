import { SubscriptionError, type JsonValue, type SubscriptionFilter, type SubscriptionSelector } from './subscriptions';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
type Segment = string | number | null;
export interface PathMatch { value: unknown; parent: unknown; root: unknown }

export function parseSubscriptionPath(path: string): Segment[] {
  if (typeof path !== 'string' || path.length > 512 || path[0] !== '$') throw new SubscriptionError('subscription_path_invalid');
  const segments: Segment[] = [];
  let offset = 1;
  while (offset < path.length) {
    const rest = path.slice(offset);
    const field = /^\.([A-Za-z_][A-Za-z0-9_-]*)/.exec(rest);
    const bracket = /^\[(\*|0|[1-9][0-9]*|"(?:[^"\\]|\\.)*"|'[^']*')\]/.exec(rest);
    let segment: Segment;
    if (field) { segment = field[1]; offset += field[0].length; }
    else if (bracket) {
      const raw = bracket[1];
      segment = raw === '*' ? null : raw.startsWith('"') ? JSON.parse(raw) : raw.startsWith("'") ? raw.slice(1, -1) : Number(raw);
      offset += bracket[0].length;
    } else throw new SubscriptionError('subscription_path_invalid');
    if (typeof segment === 'string' && forbidden.has(segment) || typeof segment === 'number' && !Number.isSafeInteger(segment)) throw new SubscriptionError('subscription_path_invalid');
    segments.push(segment);
    if (segments.length > 24) throw new SubscriptionError('subscription_path_invalid');
  }
  return segments;
}

export function subscriptionPath(root: unknown, path: string, limit = 10000, strict = false): PathMatch[] {
  let matches: PathMatch[] = [{ value: root, parent: null, root }];
  for (const segment of parseSubscriptionPath(path)) {
    const next: PathMatch[] = [];
    for (const match of matches) {
      const value = match.value;
      if (segment === null) {
        if (strict && !Array.isArray(value)) throw new SubscriptionError('subscription_catalog_invalid', 502);
        if (Array.isArray(value)) for (const child of value) {
          next.push({ value: child, parent: match.parent, root });
          if (next.length > limit) throw new SubscriptionError('subscription_limit_exceeded', 413);
        }
      } else if (value !== null && typeof value === 'object' && Object.hasOwn(value, segment)) {
        next.push({ value: (value as Record<string | number, unknown>)[segment], parent: value, root });
      } else if (strict) throw new SubscriptionError('subscription_catalog_invalid', 502);
      if (next.length > limit) throw new SubscriptionError('subscription_limit_exceeded', 413);
    }
    matches = next;
  }
  return matches;
}

export function subscriptionValue(root: unknown, path: string): unknown {
  const matches = subscriptionPath(root, path, 10000);
  if (matches.length > 1) throw new SubscriptionError('subscription_field_ambiguous');
  return matches[0]?.value;
}

export function subscriptionField(selector: SubscriptionSelector, match: PathMatch): unknown {
  if (typeof selector === 'string') return subscriptionValue(match.value, selector);
  let value = Object.hasOwn(selector, 'constant') ? selector.constant : subscriptionValue(selector.from === 'root' ? match.root : selector.from === 'parent' ? match.parent : match.value, selector.path!);
  if (value === undefined || value === null) value = selector.default ?? null;
  if (value === null) return null;
  if (selector.number || selector.scale !== undefined) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const number = Number(value);
    value = Number.isFinite(number) ? number * (selector.scale ?? 1) : null;
  }
  if (value !== null && (selector.prefix !== undefined || selector.suffix !== undefined)) value = `${selector.prefix ?? ''}${value}${selector.suffix ?? ''}`;
  return value;
}

export function subscriptionFilter(value: unknown, filter: SubscriptionFilter): boolean {
  if (filter.op === 'and') return filter.conditions.every(condition => subscriptionFilter(value, condition));
  const actual = subscriptionValue(value, filter.path);
  if (filter.op === 'exists') return actual !== undefined && actual !== null;
  const same = (other: JsonValue) => JSON.stringify(actual) === JSON.stringify(other);
  return filter.op === 'eq' ? same(filter.value) : filter.values.some(same);
}
