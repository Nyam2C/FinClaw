// packages/skills-finance/src/shared/key-rotator.ts
// Phase 27 A: 다중 API 키 라운드 로빈 + 실패 cooldown.
// Provider 들이 매 호출 시 next() 로 키를 받고, 401/429 응답 시 markFailure 로 일시 격리한다.

const DEFAULT_FAILURE_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 60분

interface KeyState {
  failures: number;
  cooldownUntil: number; // ms epoch. 0 = 가용.
}

export interface KeyRotatorOptions {
  readonly failureThreshold?: number;
  readonly cooldownMs?: number;
  readonly clock?: () => number;
}

/** 모든 키가 cooldown 상태일 때 throw. */
export class AllKeysCooldownError extends Error {
  constructor(public readonly retryAfterMs: number) {
    super(`All keys are in cooldown. Retry after ${Math.ceil(retryAfterMs / 1000)}s.`);
    this.name = 'AllKeysCooldownError';
  }
}

export class KeyRotator {
  private readonly states: Map<string, KeyState> = new Map();
  private cursor = 0;
  private readonly failureThreshold: number;
  private readonly cooldownMs: number;
  private readonly clock: () => number;

  constructor(
    private readonly keys: ReadonlyArray<string>,
    options: KeyRotatorOptions = {},
  ) {
    if (keys.length === 0) {
      throw new Error('KeyRotator requires at least one key');
    }
    this.failureThreshold = options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD;
    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.clock = options.clock ?? Date.now;
    for (const k of keys) {
      this.states.set(k, { failures: 0, cooldownUntil: 0 });
    }
  }

  /** 다음 가용 키 (라운드 로빈). 모든 키 cooldown 시 AllKeysCooldownError. */
  next(): string {
    const now = this.clock();
    const n = this.keys.length;
    let earliestCooldownEnd = Number.POSITIVE_INFINITY;
    for (let attempt = 0; attempt < n; attempt++) {
      const idx = (this.cursor + attempt) % n;
      const key = this.keys[idx];
      const state = this.states.get(key);
      if (!state) {
        continue;
      }
      if (state.cooldownUntil <= now) {
        this.cursor = (idx + 1) % n;
        return key;
      }
      earliestCooldownEnd = Math.min(earliestCooldownEnd, state.cooldownUntil);
    }
    throw new AllKeysCooldownError(earliestCooldownEnd - now);
  }

  /** 실패 누적 → 임계 도달 시 cooldown 진입. */
  markFailure(key: string, _error: Error): void {
    const state = this.states.get(key);
    if (!state) {
      return;
    }
    state.failures += 1;
    if (state.failures >= this.failureThreshold) {
      state.cooldownUntil = this.clock() + this.cooldownMs;
    }
  }

  /** 성공 시 실패 카운터 리셋. */
  markSuccess(key: string): void {
    const state = this.states.get(key);
    if (!state) {
      return;
    }
    state.failures = 0;
    state.cooldownUntil = 0;
  }

  /** 현재 가용 키 수 (cooldown 아닌). */
  availableCount(): number {
    const now = this.clock();
    let count = 0;
    for (const state of this.states.values()) {
      if (state.cooldownUntil <= now) {
        count += 1;
      }
    }
    return count;
  }

  /** 전체 키 수 (가용 + cooldown). status 표시용. */
  totalCount(): number {
    return this.keys.length;
  }
}

/**
 * env 변수에서 키 배열을 읽는다.
 * - `${envName}=k1,k2,k3` (CSV) 또는
 * - `${envName}_1=k1`, `${envName}_2=k2` ... (인덱스, 1..10).
 * 두 형태 모두 미설정 시 빈 배열.
 */
export function readKeyArray(envName: string): readonly string[] {
  const csv = process.env[envName];
  if (csv) {
    return csv
      .split(',')
      .map((k) => k.trim())
      .filter(Boolean);
  }
  const keys: string[] = [];
  for (let i = 1; i <= 10; i++) {
    const k = process.env[`${envName}_${i}`];
    if (k) {
      keys.push(k);
    }
  }
  return keys;
}
