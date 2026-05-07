// packages/skills-finance/src/shared/__tests__/key-rotator.test.ts
// Phase 27 A: KeyRotator 유닛 테스트 (mock clock 기반, 외부 API 호출 X).

import { describe, expect, it } from 'vitest';
import { AllKeysCooldownError, KeyRotator, readKeyArray } from '../key-rotator.js';

describe('KeyRotator.next', () => {
  it('cycles through all keys in round-robin', () => {
    const rotator = new KeyRotator(['k1', 'k2', 'k3']);
    const seen = new Set<string>();
    for (let i = 0; i < 3; i++) {
      seen.add(rotator.next());
    }
    expect(seen).toEqual(new Set(['k1', 'k2', 'k3']));
    // 4번째는 첫 키 재사용
    expect(rotator.next()).toBe('k1');
  });

  it('throws when constructed with empty keys', () => {
    expect(() => new KeyRotator([])).toThrow();
  });
});

describe('KeyRotator.markFailure', () => {
  it('puts key into cooldown after failureThreshold reaches', () => {
    let now = 1_000_000;
    const rotator = new KeyRotator(['k1', 'k2'], {
      failureThreshold: 2,
      cooldownMs: 60_000,
      clock: () => now,
    });
    // k1 두 번 실패 → cooldown 진입
    rotator.markFailure('k1', new Error('429'));
    rotator.markFailure('k1', new Error('429'));
    // 다음 호출은 k2
    expect(rotator.next()).toBe('k2');
    // 다시 호출하면 k1 은 여전히 cooldown 이므로 k2 가 다시 반환되어야 함
    expect(rotator.next()).toBe('k2');
    expect(rotator.availableCount()).toBe(1);

    // cooldown 만료 후 k1 부활
    now += 60_001;
    expect(rotator.availableCount()).toBe(2);
  });

  it('throws AllKeysCooldownError when every key is in cooldown', () => {
    let now = 0;
    const rotator = new KeyRotator(['k1'], {
      failureThreshold: 1,
      cooldownMs: 30_000,
      clock: () => now,
    });
    rotator.markFailure('k1', new Error('401'));
    expect(() => rotator.next()).toThrow(AllKeysCooldownError);
  });
});

describe('KeyRotator.markSuccess', () => {
  it('resets failure counter and cooldown', () => {
    let now = 0;
    const rotator = new KeyRotator(['k1'], {
      failureThreshold: 1,
      cooldownMs: 30_000,
      clock: () => now,
    });
    rotator.markFailure('k1', new Error('429'));
    expect(rotator.availableCount()).toBe(0);
    rotator.markSuccess('k1');
    expect(rotator.availableCount()).toBe(1);
    expect(rotator.next()).toBe('k1');
  });
});

describe('readKeyArray', () => {
  const ENV_NAME = '__TEST_KR_KEY';

  it('parses CSV form', () => {
    process.env[ENV_NAME] = 'a, b ,c';
    expect(readKeyArray(ENV_NAME)).toEqual(['a', 'b', 'c']);
    delete process.env[ENV_NAME];
  });

  it('parses indexed form', () => {
    process.env[`${ENV_NAME}_1`] = 'a';
    process.env[`${ENV_NAME}_2`] = 'b';
    process.env[`${ENV_NAME}_3`] = 'c';
    expect(readKeyArray(ENV_NAME)).toEqual(['a', 'b', 'c']);
    delete process.env[`${ENV_NAME}_1`];
    delete process.env[`${ENV_NAME}_2`];
    delete process.env[`${ENV_NAME}_3`];
  });

  it('returns empty when neither form set', () => {
    expect(readKeyArray(ENV_NAME)).toEqual([]);
  });

  it('CSV takes precedence over indexed when both set', () => {
    process.env[ENV_NAME] = 'csv1,csv2';
    process.env[`${ENV_NAME}_1`] = 'idx1';
    expect(readKeyArray(ENV_NAME)).toEqual(['csv1', 'csv2']);
    delete process.env[ENV_NAME];
    delete process.env[`${ENV_NAME}_1`];
  });
});
