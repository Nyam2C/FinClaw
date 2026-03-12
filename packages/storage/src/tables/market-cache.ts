import { DatabaseSync } from 'node:sqlite';

// ─── Constants ───

export const CACHE_TTL = {
  QUOTE: 300_000,
  HISTORICAL_1D: 3_600_000,
  HISTORICAL_1W: 21_600_000,
  FOREX: 900_000,
  CRYPTO: 180_000,
} as const;

// ─── Types ───

export interface MarketCacheEntry {
  readonly key: string;
  readonly data: string;
  readonly provider: string;
  readonly ttlMs: number;
  readonly cachedAt: number;
  readonly expiresAt: number;
}

// ─── CRUD ───

export function getCachedData<T>(db: DatabaseSync, key: string): T | null {
  const row = db
    .prepare('SELECT data FROM market_cache WHERE key = ? AND expires_at > ?')
    .get(key, Date.now()) as unknown as { data: string } | undefined;

  if (!row) {
    return null;
  }
  return JSON.parse(row.data) as T;
}

export function setCachedData(
  db: DatabaseSync,
  key: string,
  data: unknown,
  provider: string,
  ttlMs: number,
): void {
  const now = Date.now();
  const expiresAt = now + ttlMs;

  db.prepare(
    `INSERT INTO market_cache (key, data, provider, ttl_ms, cached_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       data = excluded.data,
       provider = excluded.provider,
       ttl_ms = excluded.ttl_ms,
       cached_at = excluded.cached_at,
       expires_at = excluded.expires_at`,
  ).run(key, JSON.stringify(data), provider, ttlMs, now, expiresAt);
}

export function purgeExpiredCache(db: DatabaseSync): number {
  const result = db.prepare('DELETE FROM market_cache WHERE expires_at <= ?').run(Date.now());
  return Number(result.changes);
}
