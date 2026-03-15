import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import type {
  AlertStore,
  AlertDefinition,
  AlertCondition,
  DeliveryChannel,
  DeliveryResult,
  AlertHistory,
} from './types.js';

// ─── Row 타입 ───
interface AlertRow {
  id: string;
  user_id: string;
  name: string;
  condition_type: string;
  condition_json: string;
  channels_json: string;
  cooldown_ms: number;
  enabled: number;
  trigger_count: number;
  last_triggered_at: number | null;
  expires_at: number | null;
  created_at: number;
  updated_at: number;
}

interface AlertHistoryRow {
  id: string;
  alert_id: string;
  triggered_at: number;
  condition_snapshot: string;
  delivery_results_json: string;
  current_value: string;
}

// ─── 헬퍼 ───
function rowToAlertDefinition(row: AlertRow): AlertDefinition {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    condition: JSON.parse(row.condition_json) as AlertCondition,
    channels: JSON.parse(row.channels_json) as DeliveryChannel[],
    cooldownMs: row.cooldown_ms,
    enabled: Boolean(row.enabled),
    expiresAt: row.expires_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToAlertHistory(row: AlertHistoryRow): AlertHistory {
  return {
    id: row.id,
    alertId: row.alert_id,
    triggeredAt: row.triggered_at,
    conditionSnapshot: row.condition_snapshot,
    deliveryResults: JSON.parse(row.delivery_results_json) as DeliveryResult[],
    currentValue: row.current_value,
  };
}

// ─── Factory ───
export function createAlertStore(db: DatabaseSync): AlertStore {
  return {
    create(input) {
      const id = randomUUID();
      const now = Date.now();
      db.prepare(
        `INSERT INTO alerts (id, user_id, name, condition_type, condition_json,
           channels_json, cooldown_ms, enabled, trigger_count, last_triggered_at,
           expires_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?, ?)`,
      ).run(
        id,
        input.userId,
        input.name,
        input.condition.type,
        JSON.stringify(input.condition),
        JSON.stringify(input.channels),
        input.cooldownMs ?? 900_000,
        (input.enabled ?? true) ? 1 : 0,
        input.expiresAt ?? null,
        now,
        now,
      );
      const created = this.getById(id);
      if (!created) {
        throw new Error(`Failed to retrieve created alert: ${id}`);
      }
      return created;
    },

    getById(id) {
      const row = db.prepare('SELECT * FROM alerts WHERE id = ?').get(id) as unknown as
        | AlertRow
        | undefined;
      return row ? rowToAlertDefinition(row) : null;
    },

    listByUser(userId) {
      const rows = db
        .prepare('SELECT * FROM alerts WHERE user_id = ? ORDER BY created_at DESC')
        .all(userId) as unknown as AlertRow[];
      return rows.map(rowToAlertDefinition);
    },

    listEnabled() {
      const now = Date.now();
      const rows = db
        .prepare(
          'SELECT * FROM alerts WHERE enabled = 1 AND (expires_at IS NULL OR expires_at > ?)',
        )
        .all(now) as unknown as AlertRow[];
      return rows.map(rowToAlertDefinition);
    },

    update(id, updates) {
      const existing = this.getById(id);
      if (!existing) {
        return null;
      }
      const now = Date.now();
      const merged = {
        name: updates.name ?? existing.name,
        condition: updates.condition ?? existing.condition,
        channels: updates.channels ?? existing.channels,
        cooldownMs: updates.cooldownMs ?? existing.cooldownMs,
        enabled: updates.enabled ?? existing.enabled,
        expiresAt: updates.expiresAt ?? existing.expiresAt,
      };
      db.prepare(
        `UPDATE alerts SET name = ?, condition_type = ?, condition_json = ?,
           channels_json = ?, cooldown_ms = ?, enabled = ?, expires_at = ?,
           updated_at = ? WHERE id = ?`,
      ).run(
        merged.name,
        merged.condition.type,
        JSON.stringify(merged.condition),
        JSON.stringify(merged.channels),
        merged.cooldownMs,
        merged.enabled ? 1 : 0,
        merged.expiresAt ?? null,
        now,
        id,
      );
      return this.getById(id);
    },

    delete(id) {
      const result = db.prepare('DELETE FROM alerts WHERE id = ?').run(id);
      return Number(result.changes) > 0;
    },

    setEnabled(id, enabled) {
      db.prepare('UPDATE alerts SET enabled = ?, updated_at = ? WHERE id = ?').run(
        enabled ? 1 : 0,
        Date.now(),
        id,
      );
    },

    recordTrigger(alertId, evaluation, results) {
      const id = randomUUID();
      const now = Date.now();
      db.prepare(
        `INSERT INTO alert_history (id, alert_id, triggered_at, condition_snapshot,
           delivery_results_json, current_value) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        alertId,
        now,
        JSON.stringify(evaluation),
        JSON.stringify(results),
        evaluation.currentValue,
      );
      db.prepare(
        'UPDATE alerts SET trigger_count = trigger_count + 1, last_triggered_at = ?, updated_at = ? WHERE id = ?',
      ).run(now, now, alertId);
      const history = this.getHistory(alertId, 1)[0];
      if (!history) {
        throw new Error(`Failed to retrieve trigger history: ${alertId}`);
      }
      return history;
    },

    getHistory(alertId, limit) {
      const sql = limit
        ? 'SELECT * FROM alert_history WHERE alert_id = ? ORDER BY triggered_at DESC LIMIT ?'
        : 'SELECT * FROM alert_history WHERE alert_id = ? ORDER BY triggered_at DESC';
      const rows = (limit
        ? db.prepare(sql).all(alertId, limit)
        : db.prepare(sql).all(alertId)) as unknown as AlertHistoryRow[];
      return rows.map(rowToAlertHistory);
    },

    getLastTrigger(alertId) {
      const rows = this.getHistory(alertId, 1);
      return rows[0] ?? null;
    },
  };
}
