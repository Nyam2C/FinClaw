// packages/infra/src/dedupe.ts

export interface DedupeOptions {
  /** TTL (ms) — 결과 캐시 유지 시간 (기본: 0, 캐시 없음) */
  ttlMs?: number;
  /** 최대 캐시 엔트리 수 (기본: 1000) */
  maxSize?: number;
}

interface Entry<T> {
  promise: Promise<T>;
  expiresAt: number;
}

/**
 * 동시 호출 중복 제거기
 *
 * - 동일 key로 동시 호출 시 첫 호출의 Promise를 공유
 * - TTL > 0이면 결과를 캐시 (TTL 만료 시 삭제)
 * - maxSize 초과 시 가장 오래된 엔트리 삭제
 */
export class Dedupe<T> {
  private readonly inflight = new Map<string, Entry<T>>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(opts: DedupeOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 0;
    this.maxSize = opts.maxSize ?? 1000;
  }

  /** 중복 제거된 실행 */
  async execute(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing && (this.ttlMs === 0 || Date.now() < existing.expiresAt)) {
      return existing.promise;
    }

    const promise = fn().finally(() => {
      if (this.ttlMs === 0) {
        this.inflight.delete(key);
      }
    });

    this.inflight.set(key, {
      promise,
      expiresAt: Date.now() + this.ttlMs,
    });

    // maxSize 초과 시 가장 오래된 것 삭제
    if (this.inflight.size > this.maxSize) {
      const firstKey = this.inflight.keys().next().value;
      if (firstKey !== undefined) {
        this.inflight.delete(firstKey);
      }
    }

    return promise;
  }

  /** 특정 키 확인 */
  check(key: string): boolean {
    return this.inflight.has(key);
  }

  /** 특정 키의 결과 조회 (없으면 undefined) */
  peek(key: string): Promise<T> | undefined {
    return this.inflight.get(key)?.promise;
  }

  /** 전체 캐시 클리어 */
  clear(): void {
    this.inflight.clear();
  }

  /** 현재 캐시 크기 */
  get size(): number {
    return this.inflight.size;
  }
}
