import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StreamEventListener } from '../src/execution/streaming.js';
import { TokenCounter } from '../src/execution/tokens.js';

describe('TokenCounter', () => {
  const CONTEXT_WINDOW = 100_000;
  let counter: TokenCounter;

  beforeEach(() => {
    counter = new TokenCounter(CONTEXT_WINDOW);
  });

  describe('add / current', () => {
    it('토큰 사용량을 누적한다', () => {
      counter.add({ inputTokens: 100, outputTokens: 50 });
      counter.add({ inputTokens: 200, outputTokens: 100, cacheReadTokens: 10 });

      expect(counter.current).toEqual({
        inputTokens: 300,
        outputTokens: 150,
        cacheReadTokens: 10,
        cacheWriteTokens: 0,
      });
    });

    it('초기 사용량은 모두 0이다', () => {
      expect(counter.current).toEqual({
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      });
    });

    it('cacheReadTokens/cacheWriteTokens가 undefined이면 0으로 처리한다', () => {
      counter.add({ inputTokens: 100, outputTokens: 50 }); // cache 필드 없음
      counter.add({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 5, cacheWriteTokens: 3 });

      expect(counter.current.cacheReadTokens).toBe(5);
      expect(counter.current.cacheWriteTokens).toBe(3);
    });
  });

  describe('usageRatio', () => {
    it('inputTokens / contextWindow 비율을 반환한다', () => {
      counter.add({ inputTokens: 50_000, outputTokens: 0 });
      expect(counter.usageRatio()).toBeCloseTo(0.5);
    });

    it('0 토큰이면 0을 반환한다', () => {
      expect(counter.usageRatio()).toBe(0);
    });
  });

  describe('remaining', () => {
    it('잔여 토큰 수를 반환한다', () => {
      counter.add({ inputTokens: 30_000, outputTokens: 0 });
      expect(counter.remaining()).toBe(70_000);
    });

    it('초과 시 0을 반환한다 (음수 방지)', () => {
      counter.add({ inputTokens: 120_000, outputTokens: 0 });
      expect(counter.remaining()).toBe(0);
    });
  });

  describe('checkThresholds', () => {
    it('79% → 경고 없음', () => {
      const listener = vi.fn<StreamEventListener>();
      counter.add({ inputTokens: 79_000, outputTokens: 0 });
      counter.checkThresholds(listener);
      expect(listener).not.toHaveBeenCalled();
    });

    it('80% → 경고 1회 발행', () => {
      const listener = vi.fn<StreamEventListener>();
      counter.add({ inputTokens: 80_000, outputTokens: 0 });
      counter.checkThresholds(listener);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith({
        type: 'usage_update',
        usage: expect.objectContaining({ inputTokens: 80_000 }),
      });
    });

    it('80% 경고는 1회만 발행한다', () => {
      const listener = vi.fn<StreamEventListener>();
      counter.add({ inputTokens: 80_000, outputTokens: 0 });
      counter.checkThresholds(listener);
      counter.checkThresholds(listener);
      // 80% 경고 1회만
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('95% → 80% + 95% 경고 모두 발행', () => {
      const listener = vi.fn<StreamEventListener>();
      counter.add({ inputTokens: 95_000, outputTokens: 0 });
      counter.checkThresholds(listener);
      // 80%, 95% 두 번 호출
      expect(listener).toHaveBeenCalledTimes(2);
    });

    it('80% 이미 경고 후 95% 도달 시 95%만 추가 발행', () => {
      const listener = vi.fn<StreamEventListener>();
      // 80% 도달
      counter.add({ inputTokens: 80_000, outputTokens: 0 });
      counter.checkThresholds(listener);
      expect(listener).toHaveBeenCalledTimes(1);

      // 95% 도달
      counter.add({ inputTokens: 15_000, outputTokens: 0 });
      counter.checkThresholds(listener);
      expect(listener).toHaveBeenCalledTimes(2); // 80%(기존) + 95%(신규)
    });

    it('리스너가 없으면 에러 없이 무시한다', () => {
      counter.add({ inputTokens: 95_000, outputTokens: 0 });
      expect(() => counter.checkThresholds()).not.toThrow();
      expect(() => counter.checkThresholds(undefined)).not.toThrow();
    });
  });
});
