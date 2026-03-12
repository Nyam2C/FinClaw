import type { Alert, AlertConditionType, TickerSymbol, Timestamp } from '@finclaw/types';
import { DatabaseSync } from 'node:sqlite';

// ─── Internal types ───

interface AlertRow {
  id: string;
  name: string | null;
  symbol: string;
  condition_type: string;
  condition_value: number;
  condition_field: string | null;
  enabled: number;
  channel_id: string | null;
  trigger_count: number;
  cooldown_ms: number;
  last_triggered_at: number | null;
  created_at: number;
}

// ─── Helpers ───

function alertRowToAlert(row: AlertRow): Alert {
  return {
    id: row.id,
    name: row.name ?? undefined,
    symbol: row.symbol as TickerSymbol,
    condition: {
      type: row.condition_type as AlertConditionType,
      value: row.condition_value,
      field: row.condition_field as Alert['condition']['field'],
    },
    enabled: Boolean(row.enabled),
    channelId: row.channel_id ?? undefined,
    triggerCount: row.trigger_count,
    cooldownMs: row.cooldown_ms,
    lastTriggeredAt: row.last_triggered_at ? (row.last_triggered_at as Timestamp) : undefined,
    createdAt: row.created_at as Timestamp,
  };
}

// ─── CRUD ───

export function createAlert(db: DatabaseSync, alert: Alert): void {
  db.prepare(
    `INSERT INTO alerts (id, name, symbol, condition_type, condition_value, condition_field,
       enabled, channel_id, trigger_count, cooldown_ms, last_triggered_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    alert.id,
    alert.name ?? null,
    alert.symbol as string,
    alert.condition.type,
    alert.condition.value,
    alert.condition.field ?? null,
    alert.enabled ? 1 : 0,
    alert.channelId ?? null,
    alert.triggerCount,
    alert.cooldownMs,
    alert.lastTriggeredAt ? (alert.lastTriggeredAt as number) : null,
    alert.createdAt as number,
  );
}

export function getAlert(db: DatabaseSync, id: string): Alert | null {
  const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as unknown as
    | AlertRow
    | undefined;
  return row ? alertRowToAlert(row) : null;
}

export function getAlertsBySymbol(
  db: DatabaseSync,
  symbol: TickerSymbol,
  options?: { enabledOnly?: boolean },
): Alert[] {
  let sql = 'SELECT * FROM alerts WHERE symbol = ?';
  if (options?.enabledOnly) {
    sql += ' AND enabled = 1';
  }

  const rows = db.prepare(sql).all(symbol as string) as unknown as AlertRow[];
  return rows.map(alertRowToAlert);
}

export function getActiveAlerts(db: DatabaseSync): Alert[] {
  const rows = db.prepare('SELECT * FROM alerts WHERE enabled = 1').all() as unknown as AlertRow[];
  return rows.map(alertRowToAlert);
}

export function updateAlertTrigger(db: DatabaseSync, id: string, triggeredAt: Timestamp): void {
  db.prepare(
    `UPDATE alerts SET trigger_count = trigger_count + 1, last_triggered_at = ? WHERE id = ?`,
  ).run(triggeredAt as number, id);
}

export function toggleAlert(db: DatabaseSync, id: string, enabled: boolean): void {
  db.prepare('UPDATE alerts SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
}

export function deleteAlert(db: DatabaseSync, id: string): boolean {
  const result = db.prepare('DELETE FROM alerts WHERE id = ?').run(id);
  return Number(result.changes) > 0;
}
