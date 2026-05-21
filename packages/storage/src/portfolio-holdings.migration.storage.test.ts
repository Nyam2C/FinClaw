// packages/storage/src/portfolio-holdings.migration.storage.test.ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import * as sqliteVec from 'sqlite-vec';
import { describe, expect, it } from 'vitest';
import { openDatabase } from './database.js';
import { addTransaction, replaceAllHoldings } from './transactions.js';

function seedV11(path: string): void {
  const db = new DatabaseSync(path, { allowExtension: true });
  sqliteVec.load(db);
  db.enableLoadExtension(false);
  db.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
  db.exec(
    `CREATE TABLE portfolios (id TEXT PRIMARY KEY, name TEXT NOT NULL, currency TEXT NOT NULL DEFAULT 'USD', updated_at INTEGER NOT NULL);`,
  );
  db.exec(
    `CREATE TABLE portfolio_holdings (portfolio_id TEXT NOT NULL, symbol TEXT NOT NULL, quantity REAL NOT NULL, average_cost REAL NOT NULL, PRIMARY KEY (portfolio_id, symbol));`,
  );
  db.prepare(
    `INSERT INTO portfolios (id,name,currency,updated_at) VALUES ('p1','main','USD',?)`,
  ).run(Date.now());
  db.prepare(
    `INSERT INTO portfolio_holdings (portfolio_id,symbol,quantity,average_cost) VALUES ('p1','AAPL',3,100)`,
  ).run();
  db.prepare(`INSERT INTO meta (key,value) VALUES ('schema_version','11')`).run();
  db.close();
}

describe('portfolio_holdings v11 → v12 (source 컬럼)', () => {
  it('마이그레이션: 기존 row 는 source=tx, idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase33-mig-'));
    const path = join(dir, 'db.sqlite');
    try {
      seedV11(path);
      const up = openDatabase({ path, enableWAL: false });
      expect(up.schemaVersion).toBe(12);
      const row = up.db
        .prepare(`SELECT source FROM portfolio_holdings WHERE symbol='AAPL'`)
        .get() as { source: string };
      expect(row.source).toBe('tx');
      up.close();
      // 재오픈 idempotent
      const up2 = openDatabase({ path, enableWAL: false });
      expect(up2.schemaVersion).toBe(12);
      up2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('recomputeHoldings 는 KIS row 를 보존한다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase33-kis-'));
    const path = join(dir, 'db.sqlite');
    try {
      seedV11(path);
      const { db, close } = openDatabase({ path, enableWAL: false });
      // KIS row 직접 주입
      db.prepare(
        `INSERT INTO portfolio_holdings (portfolio_id,symbol,quantity,average_cost,source) VALUES ('p1','NVDA',5,800,'kis')`,
      ).run();
      // 사용자 수동 거래 → recomputeHoldings 트리거
      addTransaction(db, {
        portfolioId: 'p1',
        symbol: 'AAPL' as never,
        action: 'buy',
        quantity: 2,
        price: 110,
        currency: 'USD' as never,
        executedAt: Date.now() as never,
        source: 'manual',
      });
      const kis = db
        .prepare(`SELECT quantity FROM portfolio_holdings WHERE symbol='NVDA' AND source='kis'`)
        .get() as { quantity: number } | undefined;
      expect(kis?.quantity).toBe(5); // 보존됨
      close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('replaceAllHoldings 는 kis 영역만 전면 교체', () => {
    const dir = mkdtempSync(join(tmpdir(), 'phase33-rep-'));
    const path = join(dir, 'db.sqlite');
    try {
      seedV11(path);
      const { db, close } = openDatabase({ path, enableWAL: false });
      db.prepare(
        `INSERT INTO portfolio_holdings (portfolio_id,symbol,quantity,average_cost,source) VALUES ('p1','OLD',1,1,'kis')`,
      ).run();
      replaceAllHoldings(db, 'p1', [{ symbol: 'NVDA', quantity: 5, averageCost: 800 }]);
      const old = db.prepare(`SELECT 1 FROM portfolio_holdings WHERE symbol='OLD'`).get();
      const tx = db.prepare(`SELECT source FROM portfolio_holdings WHERE symbol='AAPL'`).get() as {
        source: string;
      };
      expect(old).toBeUndefined(); // 매도 종목 정리
      expect(tx.source).toBe('tx'); // tx 영역 보존
      close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
