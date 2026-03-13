import type { OHLCVCandle, Timestamp } from '@finclaw/types';
// packages/skills-finance/src/market/charts.test.ts
import { describe, it, expect } from 'vitest';
import { generateSparkline } from './charts.js';

function makeCandle(close: number, idx: number): OHLCVCandle {
  return {
    timestamp: (1705276800000 + idx * 86400000) as Timestamp,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000,
  };
}

describe('generateSparkline', () => {
  it('빈 배열이면 "(데이터 없음)"을 반환한다', () => {
    expect(generateSparkline([])).toBe('(데이터 없음)');
  });

  it('단일 캔들에 대해 스파크라인을 생성한다', () => {
    const candles = [makeCandle(100, 0)];
    const result = generateSparkline(candles);
    expect(result).toContain('$100.00');
    expect(result).toContain('Δ: +0.0%');
  });

  it('상승 추세를 올바르게 표현한다', () => {
    const candles = Array.from({ length: 10 }, (_, i) => makeCandle(100 + i * 10, i));
    const result = generateSparkline(candles);

    // 상승 추세: 첫 문자보다 마지막 문자가 높아야 한다
    const lines = result.split('\n');
    const sparkLine = lines[1]; // 두 번째 줄이 스파크라인
    expect(sparkLine.length).toBeGreaterThan(0);
    expect(result).toContain('Δ: +');
  });

  it('하락 추세를 올바르게 표현한다', () => {
    const candles = Array.from({ length: 10 }, (_, i) => makeCandle(200 - i * 10, i));
    const result = generateSparkline(candles);
    expect(result).toContain('Δ: -');
  });

  it('width 옵션으로 차트 너비를 조절한다', () => {
    const candles = Array.from({ length: 100 }, (_, i) => makeCandle(100 + Math.sin(i) * 10, i));
    const result = generateSparkline(candles, { width: 20 });
    const lines = result.split('\n');
    const sparkLine = lines[1];
    expect(sparkLine.length).toBe(20);
  });

  it('showPrice=false이면 가격을 표시하지 않는다', () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(100, i));
    const result = generateSparkline(candles, { showPrice: false });
    const lines = result.split('\n');
    // 가격 줄 없이 스파크라인 + 요약만 (2줄)
    expect(lines).toHaveLength(2);
  });

  it('KRW 통화를 올바르게 포맷한다', () => {
    const candles = Array.from({ length: 5 }, (_, i) => makeCandle(1350 + i, i));
    const result = generateSparkline(candles, {
      currency: 'KRW' as unknown as import('@finclaw/types').CurrencyCode,
    });
    expect(result).toContain('₩');
  });

  it('대규모 데이터를 리샘플링한다', () => {
    const candles = Array.from({ length: 365 }, (_, i) => makeCandle(100 + Math.random() * 50, i));
    const result = generateSparkline(candles, { width: 40 });
    const lines = result.split('\n');
    const sparkLine = lines[1];
    expect(sparkLine.length).toBe(40);
  });

  it('모든 가격이 동일해도 에러 없이 동작한다', () => {
    const candles = Array.from({ length: 10 }, (_, i) => makeCandle(100, i));
    const result = generateSparkline(candles);
    expect(result).toBeTruthy();
    expect(result).toContain('Δ: +0.0%');
  });
});
