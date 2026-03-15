import { DatabaseSync } from 'node:sqlite';
import { describe, it, expect, beforeEach } from 'vitest';
import type { AlertStore, CreateAlertInput, PriceCondition } from '../types.js';
import { createAlertStore } from '../store.js';

// v3 스키마 DDL (database.ts의 SCHEMA_DDL에서 alerts + alert_history만 추출)
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS alerts (
  id                TEXT PRIMARY KEY,
  user_id           TEXT NOT NULL,
  name              TEXT NOT NULL,
  condition_type    TEXT NOT NULL CHECK(
    condition_type IN ('price', 'change', 'volume', 'news')
  ),
  condition_json    TEXT NOT NULL,
  channels_json     TEXT NOT NULL DEFAULT '["discord","websocket"]',
  cooldown_ms       INTEGER NOT NULL DEFAULT 900000,
  enabled           INTEGER NOT NULL DEFAULT 1,
  trigger_count     INTEGER NOT NULL DEFAULT 0,
  last_triggered_at INTEGER,
  expires_at        INTEGER,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_history (
  id                    TEXT PRIMARY KEY,
  alert_id              TEXT NOT NULL REFERENCES alerts(id) ON DELETE CASCADE,
  triggered_at          INTEGER NOT NULL,
  condition_snapshot    TEXT NOT NULL,
  delivery_results_json TEXT NOT NULL DEFAULT '[]',
  current_value         TEXT NOT NULL
);
`;

function createTestInput(overrides?: Partial<CreateAlertInput>): CreateAlertInput {
  return {
    userId: 'user-1',
    name: 'AAPL 가격 알림',
    condition: {
      type: 'price',
      ticker: 'AAPL',
      direction: 'above',
      threshold: 200,
    } satisfies PriceCondition,
    channels: ['discord', 'websocket'],
    ...overrides,
  };
}

describe('AlertStore', () => {
  let db: DatabaseSync;
  let store: AlertStore;

  beforeEach(() => {
    db = new DatabaseSync(':memory:');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA_DDL);
    store = createAlertStore(db);
  });

  describe('create + getById', () => {
    it('기본값으로 알림을 생성한다 (cooldownMs=900000, enabled=true)', () => {
      const alert = store.create(createTestInput());
      expect(alert.id).toBeTruthy();
      expect(alert.userId).toBe('user-1');
      expect(alert.name).toBe('AAPL 가격 알림');
      expect(alert.cooldownMs).toBe(900_000);
      expect(alert.enabled).toBe(true);
      expect(alert.condition.type).toBe('price');
    });

    it('커스텀 값으로 알림을 생성한다', () => {
      const alert = store.create(
        createTestInput({
          cooldownMs: 60_000,
          enabled: false,
          expiresAt: Date.now() + 86_400_000,
        }),
      );
      expect(alert.cooldownMs).toBe(60_000);
      expect(alert.enabled).toBe(false);
      expect(alert.expiresAt).toBeTruthy();
    });

    it('getById — 존재하지 않는 ID는 null 반환', () => {
      expect(store.getById('nonexistent')).toBeNull();
    });
  });

  describe('listByUser', () => {
    it('사용자별 필터링', () => {
      store.create(createTestInput({ userId: 'user-1' }));
      store.create(createTestInput({ userId: 'user-1' }));
      store.create(createTestInput({ userId: 'user-2' }));

      expect(store.listByUser('user-1')).toHaveLength(2);
      expect(store.listByUser('user-2')).toHaveLength(1);
      expect(store.listByUser('user-3')).toHaveLength(0);
    });
  });

  describe('listEnabled', () => {
    it('disabled 알림 제외', () => {
      store.create(createTestInput());
      store.create(createTestInput({ enabled: false }));
      expect(store.listEnabled()).toHaveLength(1);
    });

    it('만료된 알림 제외', () => {
      store.create(createTestInput({ expiresAt: Date.now() - 1000 }));
      expect(store.listEnabled()).toHaveLength(0);
    });

    it('미만료 알림 포함', () => {
      store.create(createTestInput({ expiresAt: Date.now() + 86_400_000 }));
      expect(store.listEnabled()).toHaveLength(1);
    });
  });

  describe('update', () => {
    it('이름/조건 변경', () => {
      const alert = store.create(createTestInput());
      const updated = store.update(alert.id, {
        name: '변경된 이름',
        condition: { type: 'price', ticker: 'TSLA', direction: 'below', threshold: 100 },
      });
      expect(updated).not.toBeNull();
      const safeUpdated = updated as NonNullable<typeof updated>;
      expect(safeUpdated.name).toBe('변경된 이름');
      expect((safeUpdated.condition as PriceCondition).ticker).toBe('TSLA');
    });

    it('존재하지 않는 ID → null', () => {
      expect(store.update('nonexistent', { name: 'x' })).toBeNull();
    });
  });

  describe('delete', () => {
    it('성공 시 true', () => {
      const alert = store.create(createTestInput());
      expect(store.delete(alert.id)).toBe(true);
      expect(store.getById(alert.id)).toBeNull();
    });

    it('존재하지 않는 ID → false', () => {
      expect(store.delete('nonexistent')).toBe(false);
    });
  });

  describe('recordTrigger + getHistory + getLastTrigger', () => {
    it('이력 기록/조회, trigger_count 증가', () => {
      const alert = store.create(createTestInput());
      const evaluation = { triggered: true, currentValue: '205', message: '조건 충족' };
      const deliveryResults = [{ channel: 'log' as const, success: true, deliveredAt: Date.now() }];

      const history = store.recordTrigger(alert.id, evaluation, deliveryResults);
      expect(history.alertId).toBe(alert.id);
      expect(history.currentValue).toBe('205');

      const lastTrigger = store.getLastTrigger(alert.id);
      expect(lastTrigger).toBeTruthy();
      expect(lastTrigger?.alertId).toBe(alert.id);

      const allHistory = store.getHistory(alert.id);
      expect(allHistory).toHaveLength(1);

      // trigger_count가 증가했는지 확인
      const updated = store.getById(alert.id);
      expect(updated?.triggerCount).toBe(1);
    });
  });
});
