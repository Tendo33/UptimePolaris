import type { Env } from '../../types';
import { getDB } from '../db/factory';
import { tickLeaseSQL } from '../db/sql/heartbeat';
import { TickLeaseLost } from './tick-commit';

export async function withWriterLease<T>(
  env: Env,
  work: (owner: string, ensure: () => Promise<void>) => Promise<T>,
  cronPriority = false,
  deadlineMs?: number,
): Promise<{ acquired: false } | { acquired: true; value: T }> {
  const db = getDB(env), owner = crypto.randomUUID(), now = Math.floor(Date.now() / 1000);
  const deadline = deadlineMs === undefined ? Infinity : Math.floor(deadlineMs / 1000);
  if (now >= deadline) return { acquired: false };
  let sql: string;
  if (cronPriority) {
    sql = db.type === 'postgres'
      ? 'UPDATE cron_tick_lease SET owner=$1,lease_until=$2 WHERE id=1 AND lease_until<=$3 AND completed_minute>=$4'
      : 'UPDATE cron_tick_lease SET owner=?,lease_until=? WHERE id=1 AND lease_until<=? AND completed_minute>=?';
  } else {
    sql = db.type === 'postgres'
      ? 'INSERT INTO cron_tick_lease(id,owner,lease_until,completed_minute) VALUES(1,$1,$2,-1) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until WHERE cron_tick_lease.lease_until<=$3'
      : 'INSERT INTO cron_tick_lease(id,owner,lease_until,completed_minute) VALUES(1,?,?, -1) ON CONFLICT(id) DO UPDATE SET owner=excluded.owner,lease_until=excluded.lease_until WHERE cron_tick_lease.lease_until<=?';
  }
  const claim = await db.execute(sql, [owner, Math.min(now + 60, deadline), now, ...(cronPriority ? [Math.floor(now / 60) * 60] : [])]);
  if (claim.rowsAffected !== 1) return { acquired: false };
  let lost = false, renewing: Promise<void> | undefined;
  const ensure = async () => {
    if (lost) throw new TickLeaseLost();
    const at = Math.floor(Date.now() / 1000);
    if (at >= deadline) { lost = true; throw new TickLeaseLost(); }
    const result = await db.execute(tickLeaseSQL[db.type].renewTick, [Math.min(at + 60, deadline), owner, at]);
    if (result.rowsAffected !== 1) {
      lost = true;
      throw new TickLeaseLost();
    }
  };
  const timer = setInterval(() => {
    renewing ??= ensure().catch(() => { lost = true; }).finally(() => { renewing = undefined; });
  }, 15000);
  try { return { acquired: true, value: await work(owner, ensure) }; }
  finally {
    clearInterval(timer);
    if (renewing) await renewing;
    await db.execute(tickLeaseSQL[db.type].releaseTick, [0, 0, owner, 0, Math.floor(Date.now() / 1000)]);
  }
}
