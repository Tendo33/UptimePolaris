import type { DBAdapter } from '../db/adapter';
import { SubscriptionError, type Subscription, type SubscriptionItem } from '../../../../../shared/subscriptions';
import { subscriptionItemView } from '../../../../../shared/subscription-runtime';

type Write = { sql: string; params: unknown[] };
export class SubscriptionStore {
  constructor(readonly db: DBAdapter) {}
  sql(value: string): string { let i = 0; return this.db.type === 'postgres' ? value.replace(/\?/g, () => `$${++i}`) : value; }
  write(sql: string, params: unknown[]): Write { return { sql: this.sql(sql), params }; }

  async list(): Promise<Subscription[]> {
    const rows = await this.db.query<{ json: string }>('SELECT json FROM subscriptions ORDER BY id');
    return rows.map(row => JSON.parse(row.json));
  }
  async get(id: string): Promise<Subscription> {
    const row = await this.db.queryOne<{ json: string }>(this.sql('SELECT json FROM subscriptions WHERE id=?'), [id]);
    if (!row) throw new SubscriptionError('not_found', 404);
    return JSON.parse(row.json);
  }
  async statusCounts(subscription: Subscription): Promise<NonNullable<Subscription['statusCounts']>> {
    const field = (path: string) => this.db.type === 'postgres' ? `(json::jsonb#>>'{${path.replaceAll('.', ',')}}')` : `json_extract(json,'$.${path}')`;
    const rows = await this.db.query<{ mode: string; version: string; status: string | null; observed: number | null; fetched: number | null; source_current: string | number | null }>(this.sql(`SELECT ${field('mode')} AS mode,${field('syncRevision')} AS version,${field('sourceCurrent')} AS source_current,${field('observation.status')} AS status,${field('observation.observedAt')} AS observed,${field('observation.fetchedAt')} AS fetched FROM subscription_items WHERE subscription_id=? AND selected=1 AND ${field('removedAt')} IS NULL`), [subscription.id]);
    const counts: NonNullable<Subscription['statusCounts']> = {}, now = Math.floor(Date.now() / 1000);
    for (const row of rows) {
      const point = row.status ? { status: row.status, observedAt: row.observed === null ? null : Number(row.observed), fetchedAt: Number(row.fetched) } : null;
      const status = subscriptionItemView({ mode: row.mode, syncRevision: row.version, sourceCurrent: row.source_current !== 0 && row.source_current !== 'false', removedAt: null, observation: point } as SubscriptionItem, subscription, now).displayStatus;
      counts[status] = (counts[status] ?? 0) + 1;
    }
    return counts;
  }
  async items(id: string, sourceIds?: string[]): Promise<SubscriptionItem[]> {
    if (sourceIds?.length === 0) return [];
    return (await this.db.query<{ json: string }>(this.sql(`SELECT json FROM subscription_items WHERE subscription_id=?${sourceIds ? ` AND source_id IN (${sourceIds.map(() => '?').join(',')})` : ''} ORDER BY source_id`), [id, ...(sourceIds ?? [])])).map(row => JSON.parse(row.json));
  }
  async publicItems(): Promise<SubscriptionItem[]> {
    return (await this.db.query<{ json: string }>('SELECT i.json FROM subscription_items i JOIN subscriptions s ON s.id=i.subscription_id WHERE i.selected=1 AND i.is_public=1 ORDER BY i.subscription_id,i.source_id')).map(row => JSON.parse(row.json));
  }
  async item(id: string): Promise<SubscriptionItem> {
    const row = await this.db.queryOne<{ json: string }>(this.sql('SELECT json FROM subscription_items WHERE id=?'), [id]);
    if (!row) throw new SubscriptionError('not_found', 404);
    return JSON.parse(row.json);
  }
  documentWrite(kind: string, id: string, value: unknown, subscriptionId: string | null = null, expiresAt = 0): Write {
    return this.write('INSERT INTO subscription_documents(kind,id,subscription_id,json,expires_at) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json,subscription_id=excluded.subscription_id,expires_at=excluded.expires_at', [kind, id, subscriptionId, JSON.stringify(value), expiresAt]);
  }
  async putDocument(kind: string, id: string, value: unknown, subscriptionId: string | null = null, expiresAt = 0): Promise<void> {
    const old = await this.db.queryOne<{ json: string }>(this.sql('SELECT json FROM subscription_documents WHERE kind=? AND id=?'), [kind, id]);
    const oldParts = old ? JSON.parse(old.json)?._parts?.id : null;
    const json = JSON.stringify(value);
    if (json.length > 131072) {
      const partId = crypto.randomUUID(), parts: Write[] = [];
      for (let offset = 0; offset < json.length; offset += 65536) parts.push(this.documentWrite('document-part', `${partId}:${parts.length}`, { value: json.slice(offset, offset + 65536) }, subscriptionId, expiresAt));
      for (let offset = 0; offset < parts.length; offset += 20) await this.db.commit(parts.slice(offset, offset + 20));
      value = { _parts: { id: partId, count: parts.length } };
    }
    const write = this.documentWrite(kind, id, value, subscriptionId, expiresAt);
    await this.db.execute(write.sql, write.params);
    if (typeof oldParts === 'string') await this.db.execute(this.sql("UPDATE subscription_documents SET expires_at=? WHERE kind='document-part' AND id LIKE ?"), [Math.floor(Date.now() / 1000) + 300, `${oldParts}:%`]);
  }
  async document<T>(kind: string, id: string): Promise<T | null> {
    const row = await this.db.queryOne<{ json: string; expires_at: number }>(this.sql('SELECT json,expires_at FROM subscription_documents WHERE kind=? AND id=?'), [kind, id]);
    if (!row || Number(row.expires_at) && Number(row.expires_at) <= Math.floor(Date.now() / 1000)) return null;
    const value = JSON.parse(row.json);
    if (!value?._parts) return value;
    const { id: partId, count } = value._parts;
    if (typeof partId !== 'string' || !Number.isInteger(count) || count < 1 || count > 2048) throw new SubscriptionError('subscription_cache_invalid', 503);
    const parts: string[] = [];
    for (let index = 0; index < count; index++) {
      const part = await this.document<{ value: string }>('document-part', `${partId}:${index}`);
      if (!part) throw new SubscriptionError('subscription_cache_invalid', 503);
      parts.push(part.value);
    }
    return JSON.parse(parts.join(''));
  }
  async documents<T>(kind: string, subscriptionId?: string, limit = 100): Promise<T[]> {
    const rows = await this.db.query<{ id: string; json: string }>(this.sql(`SELECT id,json FROM subscription_documents WHERE kind=? AND (expires_at=0 OR expires_at>?)${subscriptionId ? ' AND subscription_id=?' : ''} ORDER BY id DESC LIMIT ?`), [kind, Math.floor(Date.now() / 1000), ...(subscriptionId ? [subscriptionId] : []), limit]);
    const values = await Promise.all(rows.map(row => JSON.parse(row.json)?._parts ? this.document<T>(kind, row.id) : JSON.parse(row.json) as T));
    return values.filter(value => value !== null) as T[];
  }
  itemWrite(item: SubscriptionItem): Write {
    return this.write('INSERT INTO subscription_items(id,subscription_id,source_id,json,revision,selected,is_public) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,json=excluded.json,revision=excluded.revision,selected=excluded.selected,is_public=excluded.is_public', [item.id, item.subscriptionId, item.identityArchived ? `archived:${item.id}` : item.sourceItemId, JSON.stringify(item), item.revision, Number(item.selected), Number(item.isPublic)]);
  }
  async identityWrites(previous: SubscriptionItem[], next: SubscriptionItem[], subscriptionId: string): Promise<Write[]> {
    const batchId = crypto.randomUUID();
    for (let offset = 0; offset < next.length; offset += 25) await this.db.commit(next.slice(offset, offset + 25).map(item => this.documentWrite('identity-item', `${batchId}:${item.id}`, { item, previous: previous.find(old => old.id === item.id) }, subscriptionId, Math.floor(Date.now() / 1000) + 600)));
    const field = (path: string) => this.db.type === 'postgres' ? `(d.json::jsonb#>>'{${path.replaceAll('.', ',')}}')` : `json_extract(d.json,'$.${path}')`;
    const json = this.db.type === 'postgres' ? `(d.json::jsonb->'item')::text` : "json_extract(d.json,'$.item')";
    const flag = (path: string) => this.db.type === 'postgres' ? `CASE WHEN ${field(path)}='true' THEN 1 ELSE 0 END` : field(path);
    const prefix = `${batchId}:%`, guardId = crypto.randomUUID();
    return [
      this.write(`INSERT INTO subscription_documents(kind,id,json) VALUES('guard',?,CASE WHEN NOT EXISTS(SELECT 1 FROM subscription_documents d JOIN subscription_items i ON i.id=${field('item.id')} WHERE d.kind='identity-item' AND d.id LIKE ? AND ${this.db.type === 'postgres' ? "i.json::jsonb<>d.json::jsonb->'previous'" : "i.json<>json_extract(d.json,'$.previous')"}) THEN '{}' ELSE NULL END)`, [guardId, prefix]),
      this.write("UPDATE subscription_items SET source_id='archived:' || id WHERE subscription_id=?", [subscriptionId]),
      this.write(`INSERT INTO subscription_items(id,subscription_id,source_id,json,revision,selected,is_public) SELECT ${field('item.id')},d.subscription_id,CASE WHEN ${flag('item.identityArchived')}=1 THEN 'archived:' || ${field('item.id')} ELSE ${field('item.sourceItemId')} END,${json},${field('item.revision')},${flag('item.selected')},${flag('item.isPublic')} FROM subscription_documents d WHERE d.kind='identity-item' AND d.id LIKE ? ON CONFLICT(id) DO UPDATE SET source_id=excluded.source_id,json=excluded.json,revision=excluded.revision,selected=excluded.selected,is_public=excluded.is_public`, [prefix]),
      this.write("DELETE FROM subscription_documents WHERE kind='identity-item' AND id LIKE ?", [prefix]), this.write("DELETE FROM subscription_documents WHERE kind='guard' AND id=?", [guardId]),
    ];
  }
  async create(subscription: Subscription, writes: Write[], items: SubscriptionItem[] = []): Promise<void> {
    for (let offset = 0; offset < items.length; offset += 25) await this.db.commit(items.slice(offset, offset + 25).map(item => this.documentWrite('initial-item', item.id, item, subscription.id, Math.floor(Date.now() / 1000) + 600)));
    const field = (name: string) => this.db.type === 'postgres' ? `(json::jsonb->>'${name}')` : `json_extract(json,'$.${name}')`;
    const flag = (name: string) => this.db.type === 'postgres' ? `CASE WHEN ${field(name)}='true' THEN 1 ELSE 0 END` : field(name);
    await this.db.commit([this.write('INSERT INTO subscriptions(id,json,revision,sync_revision,enabled,next_due) VALUES(?,?,?,?,?,?)', [subscription.id, JSON.stringify(subscription), subscription.revision, subscription.syncRevision, Number(subscription.enabled), subscription.runtime.nextDueAt]), ...writes,
      this.write(`INSERT INTO subscription_items(id,subscription_id,source_id,json,revision,selected,is_public) SELECT ${field('id')},subscription_id,${field('sourceItemId')},json,${field('revision')},${flag('selected')},${flag('isPublic')} FROM subscription_documents WHERE kind='initial-item' AND subscription_id=?`, [subscription.id]),
      this.write("DELETE FROM subscription_documents WHERE kind='initial-item' AND subscription_id=?", [subscription.id]),
    ]);
  }
  async cleanup(): Promise<void> {
    await this.db.execute(this.sql('DELETE FROM subscription_documents WHERE (kind,id) IN (SELECT kind,id FROM subscription_documents WHERE expires_at>0 AND expires_at<=? ORDER BY expires_at LIMIT 500)'), [Math.floor(Date.now() / 1000)]);
  }
  async update(previous: Subscription, next: Subscription, writes: Write[] = []): Promise<void> {
    const token = crypto.randomUUID();
    const guard = this.write("INSERT INTO subscription_documents(kind,id,json) VALUES('guard',?,CASE WHEN EXISTS(SELECT 1 FROM subscriptions WHERE id=? AND revision=? AND json=?) THEN '{}' ELSE NULL END)", [token, previous.id, previous.revision, JSON.stringify(previous)]);
    try {
      await this.db.commit([guard, this.write('UPDATE subscriptions SET json=?,revision=?,sync_revision=?,enabled=?,next_due=? WHERE id=?', [JSON.stringify(next), next.revision, next.syncRevision, Number(next.enabled && next.archivedAt === null), next.runtime.nextDueAt, previous.id]), ...writes, this.write("DELETE FROM subscription_documents WHERE kind='guard' AND id=?", [token])]);
    } catch (error) {
      if (/subscription_documents.*json|json.*not.null/i.test(String(error))) throw new SubscriptionError('revision_conflict', 409);
      throw error;
    }
  }
  async claim(id: string, version: string, token: string, now: number): Promise<boolean> {
    const result = await this.db.execute(this.sql('UPDATE subscriptions SET lease_token=?,lease_until=? WHERE id=? AND enabled=1 AND sync_revision=? AND lease_until<=?'), [token, now + 90, id, version, now]);
    return result.rowsAffected === 1;
  }
  async commitRun(subscription: Subscription, token: string, writes: Write[], final = false): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const guardId = crypto.randomUUID();
    const guard = this.write("INSERT INTO subscription_documents(kind,id,json) VALUES('guard',?,CASE WHEN EXISTS(SELECT 1 FROM subscriptions WHERE id=? AND revision=? AND sync_revision=? AND lease_token=? AND lease_until>? AND enabled=1) THEN '{}' ELSE NULL END)", [guardId, subscription.id, subscription.revision, subscription.syncRevision, token, now]);
    const finish = final ? [this.write('UPDATE subscriptions SET lease_token=NULL,lease_until=0,next_due=? WHERE id=? AND lease_token=?', [subscription.runtime.nextDueAt, subscription.id, token])] : [this.write('UPDATE subscriptions SET lease_until=? WHERE id=? AND lease_token=?', [now + 90, subscription.id, token])];
    try { await this.db.commit([guard, ...writes, ...finish, this.write("DELETE FROM subscription_documents WHERE kind='guard' AND id=?", [guardId])]); }
    catch (error) {
      if (/subscription_documents.*json|json.*not.null/i.test(String(error))) throw new SubscriptionError('subscription_run_obsolete', 409);
      throw error;
    }
  }
  guardItem(item: SubscriptionItem): Write[] {
    const id = crypto.randomUUID();
    return [this.write("INSERT INTO subscription_documents(kind,id,json) VALUES('guard',?,CASE WHEN EXISTS(SELECT 1 FROM subscription_items WHERE id=? AND revision=?) THEN '{}' ELSE NULL END)", [id, item.id, item.revision]), this.write("DELETE FROM subscription_documents WHERE kind='guard' AND id=?", [id])];
  }
  async remove(subscription: Subscription): Promise<void> {
    await this.update(subscription, { ...subscription, enabled: false }, [
      this.write(`DELETE FROM pending_notifications WHERE ${this.db.type === 'postgres' ? "payload_json::jsonb->'event'->>'subscriptionId'" : "json_extract(payload_json,'$.event.subscriptionId')"}=?`, [subscription.id]),
      this.write('DELETE FROM subscription_documents WHERE subscription_id=?', [subscription.id]),
      this.write('DELETE FROM subscription_items WHERE subscription_id=?', [subscription.id]),
      this.write('DELETE FROM subscriptions WHERE id=?', [subscription.id]),
    ]);
  }
}
