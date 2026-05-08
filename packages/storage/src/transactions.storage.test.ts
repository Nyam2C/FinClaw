import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { CurrencyCode, TickerSymbol, Timestamp } from '@finclaw/types';
import * as sqliteVec from 'sqlite-vec';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Database } from './database.js';
import {
  addTransaction,
  deleteTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
} from './transactions.js';

const PORTFOLIO_ID = 'pf-test';
const AAPL = 'AAPL' as TickerSymbol;
const USD = 'USD' as CurrencyCode;

function seedPortfolio(db: Database['db'], id: string = PORTFOLIO_ID): void {
  db.prepare(
    "INSERT INTO portfolios (id, name, currency, updated_at) VALUES (?, 'Test', 'USD', 1700000000000)",
  ).run(id);
}

function getHolding(
  db: Database['db'],
  portfolioId: string,
  symbol: string,
): { quantity: number; average_cost: number } | null {
  const row = db
    .prepare(
      'SELECT quantity, average_cost FROM portfolio_holdings WHERE portfolio_id = ? AND symbol = ?',
    )
    .get(portfolioId, symbol) as unknown as { quantity: number; average_cost: number } | undefined;
  return row ?? null;
}

describe('v3 → v4 migration', () => {
  let tmpDir: string;
  let dbPath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'finclaw-mig-'));
    dbPath = join(tmpDir, 'v3.db');
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('synthesizes transactions from existing portfolio_holdings and preserves quantities', () => {
    // 1) v3 fixture 작성: openDatabase 를 호출하지 않고 raw 로 v3 스키마 + meta='3' 기록
    const raw = new DatabaseSync(dbPath, { allowExtension: true });
    sqliteVec.load(raw);
    raw.enableLoadExtension(false);
    raw.exec('PRAGMA foreign_keys = ON');
    raw.exec(`
      CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE portfolios (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        currency TEXT NOT NULL DEFAULT 'USD',
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE portfolio_holdings (
        portfolio_id TEXT NOT NULL,
        symbol TEXT NOT NULL,
        quantity REAL NOT NULL,
        average_cost REAL NOT NULL,
        PRIMARY KEY (portfolio_id, symbol),
        FOREIGN KEY (portfolio_id) REFERENCES portfolios(id) ON DELETE CASCADE
      );
      INSERT INTO meta (key, value) VALUES ('schema_version', '3');
      INSERT INTO portfolios (id, name, currency, updated_at) VALUES
        ('pf1', 'Default', 'USD', 1700000000000);
      INSERT INTO portfolio_holdings (portfolio_id, symbol, quantity, average_cost) VALUES
        ('pf1', 'AAPL', 10, 180),
        ('pf1', 'MSFT', 5, 300);
    `);
    raw.close();

    // 2) openDatabase 로 v4 마이그레이션 트리거
    const database = openDatabase({ path: dbPath });
    try {
      // schema_version 갱신 (v3 → 최신 SCHEMA_VERSION 까지 연속 적용)
      const versionRow = database.db
        .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
        .get() as unknown as { value: string };
      expect(versionRow.value).toBe('10');

      // synthetic transactions 2건 생성
      const txnRows = database.db
        .prepare('SELECT symbol, action, quantity, price, source FROM transactions ORDER BY symbol')
        .all() as unknown as Array<{
        symbol: string;
        action: string;
        quantity: number;
        price: number;
        source: string;
      }>;
      expect(txnRows).toHaveLength(2);
      expect(txnRows[0]).toMatchObject({
        symbol: 'AAPL',
        action: 'buy',
        quantity: 10,
        price: 180,
        source: 'manual',
      });
      expect(txnRows[1]).toMatchObject({
        symbol: 'MSFT',
        action: 'buy',
        quantity: 5,
        price: 300,
        source: 'manual',
      });

      // holdings 보존 (마이그레이션이 holdings 자체를 건드리지 않음)
      expect(getHolding(database.db, 'pf1', 'AAPL')).toEqual({ quantity: 10, average_cost: 180 });
      expect(getHolding(database.db, 'pf1', 'MSFT')).toEqual({ quantity: 5, average_cost: 300 });
    } finally {
      database.close();
    }

    // 3) 다시 openDatabase 호출해도 transactions 가 중복 발행되지 않음 (idempotent)
    const reopened = openDatabase({ path: dbPath });
    try {
      const count = reopened.db
        .prepare('SELECT COUNT(*) as c FROM transactions')
        .get() as unknown as { c: number };
      expect(count.c).toBe(2);
    } finally {
      reopened.close();
    }
  });
});

describe('addTransaction / recomputeHoldings', () => {
  let database: Database;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
    seedPortfolio(database.db);
  });

  afterEach(() => {
    database.close();
  });

  it('buy 10@180 → holdings AAPL 10주 / avg 180', () => {
    addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: AAPL,
      action: 'buy',
      quantity: 10,
      price: 180,
      currency: USD,
      executedAt: 1710000000000 as Timestamp,
      source: 'manual',
    });

    const h = getHolding(database.db, PORTFOLIO_ID, 'AAPL');
    expect(h).not.toBeNull();
    expect(h?.quantity).toBe(10);
    expect(h?.average_cost).toBe(180);
  });

  it('buy 10@180 + buy 5@200 → avg = (10*180 + 5*200)/15 ≈ 186.6667', () => {
    addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: AAPL,
      action: 'buy',
      quantity: 10,
      price: 180,
      currency: USD,
      executedAt: 1710000000000 as Timestamp,
      source: 'manual',
    });
    addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: AAPL,
      action: 'buy',
      quantity: 5,
      price: 200,
      currency: USD,
      executedAt: 1710100000000 as Timestamp,
      source: 'manual',
    });

    const h = getHolding(database.db, PORTFOLIO_ID, 'AAPL');
    expect(h?.quantity).toBe(15);
    expect(h?.average_cost).toBeCloseTo((10 * 180 + 5 * 200) / 15, 4);
  });

  it('+ sell 3@220 → quantity=12, avg 그대로 186.6667', () => {
    addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: AAPL,
      action: 'buy',
      quantity: 10,
      price: 180,
      currency: USD,
      executedAt: 1710000000000 as Timestamp,
      source: 'manual',
    });
    addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: AAPL,
      action: 'buy',
      quantity: 5,
      price: 200,
      currency: USD,
      executedAt: 1710100000000 as Timestamp,
      source: 'manual',
    });
    addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: AAPL,
      action: 'sell',
      quantity: 3,
      price: 220,
      currency: USD,
      executedAt: 1710200000000 as Timestamp,
      source: 'manual',
    });

    const h = getHolding(database.db, PORTFOLIO_ID, 'AAPL');
    expect(h?.quantity).toBe(12);
    expect(h?.average_cost).toBeCloseTo((10 * 180 + 5 * 200) / 15, 4);
  });

  it('첫 buy 삭제 → holdings 재계산: quantity=2, avg=200 (5*200)', () => {
    const buy1 = addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: AAPL,
      action: 'buy',
      quantity: 10,
      price: 180,
      currency: USD,
      executedAt: 1710000000000 as Timestamp,
      source: 'manual',
    });
    addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: AAPL,
      action: 'buy',
      quantity: 5,
      price: 200,
      currency: USD,
      executedAt: 1710100000000 as Timestamp,
      source: 'manual',
    });
    addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: AAPL,
      action: 'sell',
      quantity: 3,
      price: 220,
      currency: USD,
      executedAt: 1710200000000 as Timestamp,
      source: 'manual',
    });

    const ok = deleteTransaction(database.db, buy1.id);
    expect(ok).toBe(true);

    const h = getHolding(database.db, PORTFOLIO_ID, 'AAPL');
    // 남은: buy 5@200 + sell 3@220 → quantity=2, avg=200
    expect(h?.quantity).toBe(2);
    expect(h?.average_cost).toBeCloseTo(200, 4);
  });

  it('listTransactions — executed_at DESC 정렬', () => {
    addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: AAPL,
      action: 'buy',
      quantity: 10,
      price: 180,
      currency: USD,
      executedAt: 1710000000000 as Timestamp,
      source: 'manual',
    });
    addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: AAPL,
      action: 'buy',
      quantity: 5,
      price: 200,
      currency: USD,
      executedAt: 1710100000000 as Timestamp,
      source: 'manual',
    });

    const list = listTransactions(database.db, { portfolioId: PORTFOLIO_ID });
    expect(list).toHaveLength(2);
    expect(list[0].executedAt).toBe(1710100000000);
    expect(list[1].executedAt).toBe(1710000000000);
  });

  it('recomputeHoldings — quantity 0 이면 holdings 행 제거', () => {
    addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: AAPL,
      action: 'buy',
      quantity: 10,
      price: 180,
      currency: USD,
      executedAt: 1710000000000 as Timestamp,
      source: 'manual',
    });
    addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: AAPL,
      action: 'sell',
      quantity: 10,
      price: 200,
      currency: USD,
      executedAt: 1710100000000 as Timestamp,
      source: 'manual',
    });

    expect(getHolding(database.db, PORTFOLIO_ID, 'AAPL')).toBeNull();
  });

  it('updateTransaction — quantity 변경 시 holdings 재계산', () => {
    const txn = addTransaction(database.db, {
      portfolioId: PORTFOLIO_ID,
      symbol: AAPL,
      action: 'buy',
      quantity: 10,
      price: 180,
      currency: USD,
      executedAt: 1710000000000 as Timestamp,
      source: 'manual',
    });

    updateTransaction(database.db, txn.id, { quantity: 20 });

    const h = getHolding(database.db, PORTFOLIO_ID, 'AAPL');
    expect(h?.quantity).toBe(20);
    expect(h?.average_cost).toBe(180);
  });

  it('getTransaction — 미존재 id 면 null', () => {
    expect(getTransaction(database.db, 'nope')).toBeNull();
  });
});
