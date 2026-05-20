import { describe, it, expect } from 'vitest';
import {
  detectToolCallLoop,
  hashToolCall,
  hashToolResult,
  appendHistory,
  WARNING_THRESHOLD,
  CRITICAL_THRESHOLD,
  GLOBAL_CIRCUIT_BREAKER_THRESHOLD,
  type ToolCallRecord,
} from '../../src/agents/tools/loop-detector.js';

describe('hashToolCall', () => {
  it('returns same hash for same params (key order independent)', () => {
    const a = hashToolCall('market.fetch', { symbol: 'AAPL', limit: 10 });
    const b = hashToolCall('market.fetch', { limit: 10, symbol: 'AAPL' });
    expect(a).toBe(b);
  });
  it('returns different hash for different tool', () => {
    expect(hashToolCall('a', {})).not.toBe(hashToolCall('b', {}));
  });
});

describe('detectToolCallLoop', () => {
  const sameArgs = { symbol: 'AAPL' };
  const sameResult = { price: 180 };

  function buildHistory(count: number): ToolCallRecord[] {
    let h: ToolCallRecord[] = [];
    for (let i = 0; i < count; i++) {
      h = appendHistory(h, {
        toolName: 'market.fetch',
        argsHash: hashToolCall('market.fetch', sameArgs),
        resultHash: hashToolResult(sameResult, undefined),
      });
    }
    return h;
  }

  it('returns stuck:false under warning threshold', () => {
    const h = buildHistory(WARNING_THRESHOLD - 2);
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    expect(r.stuck).toBe(false);
  });

  it('returns warning at threshold (10)', () => {
    const h = buildHistory(WARNING_THRESHOLD);
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    expect(r.stuck).toBe(true);
    if (r.stuck) {
      expect(r.level).toBe('warning');
      expect(r.detector).toBe('generic_repeat');
    }
  });

  it('returns critical at threshold (20)', () => {
    const h = buildHistory(CRITICAL_THRESHOLD);
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    expect(r.stuck).toBe(true);
    if (r.stuck) {
      expect(r.level).toBe('critical');
    }
  });

  it('returns global_circuit_breaker at threshold (30)', () => {
    const h = buildHistory(GLOBAL_CIRCUIT_BREAKER_THRESHOLD);
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    expect(r.stuck).toBe(true);
    if (r.stuck) {
      expect(r.detector).toBe('global_circuit_breaker');
    }
  });

  it('breaks streak when result changes', () => {
    let h = buildHistory(15);
    // 다른 result 1번 끼움 → streak 깨짐
    h = appendHistory(h, {
      toolName: 'market.fetch',
      argsHash: hashToolCall('market.fetch', sameArgs),
      resultHash: hashToolResult({ price: 200 }, undefined),
    });
    // 새 result 로 5번 더 — 새 streak 5 (< warning 10)
    for (let i = 0; i < 5; i++) {
      h = appendHistory(h, {
        toolName: 'market.fetch',
        argsHash: hashToolCall('market.fetch', sameArgs),
        resultHash: hashToolResult({ price: 200 }, undefined),
      });
    }
    const r = detectToolCallLoop(h, 'market.fetch', sameArgs);
    expect(r.stuck).toBe(false);
  });

  it('appendHistory caps at TOOL_CALL_HISTORY_SIZE (30)', () => {
    const h = buildHistory(50);
    expect(h.length).toBe(30);
  });
});
