import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Database } from '../database.js';
import { CACHE_TTL, getCachedData, setCachedData } from './market-cache.js';

describe('market-cache', () => {
  let database: Database;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
  });

  afterEach(() => {
    database.close();
  });

  it('setCachedData 후 getCachedData로 조회', () => {
    const data = { price: 150.5, symbol: 'AAPL' };
    setCachedData(database.db, 'quote:AAPL', data, 'yahoo', CACHE_TTL.QUOTE);

    const result = getCachedData<{ price: number; symbol: string }>(database.db, 'quote:AAPL');
    expect(result).toEqual(data);
  });

  it('TTL 만료 후 getCachedData → null', () => {
    setCachedData(database.db, 'expire-test', { v: 1 }, 'test', 1);

    // Manually set expires_at in the past
    database.db
      .prepare('UPDATE market_cache SET expires_at = ? WHERE key = ?')
      .run(Date.now() - 1000, 'expire-test');

    const result = getCachedData(database.db, 'expire-test');
    expect(result).toBeNull();
  });

  it('동일 key에 setCachedData → 덮어쓰기 (UPSERT)', () => {
    setCachedData(database.db, 'upsert-key', { v: 1 }, 'p1', 60000);
    setCachedData(database.db, 'upsert-key', { v: 2 }, 'p2', 60000);

    const result = getCachedData<{ v: number }>(database.db, 'upsert-key');
    expect(result).toEqual({ v: 2 });
  });

  it('CACHE_TTL 상수 값 확인', () => {
    expect(CACHE_TTL.QUOTE).toBe(300_000);
    expect(CACHE_TTL.HISTORICAL_1D).toBe(3_600_000);
    expect(CACHE_TTL.HISTORICAL_1W).toBe(21_600_000);
    expect(CACHE_TTL.FOREX).toBe(900_000);
    expect(CACHE_TTL.CRYPTO).toBe(180_000);
  });
});
