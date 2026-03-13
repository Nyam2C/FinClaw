// packages/skills-finance/src/market/charts.ts
import type { OHLCVCandle } from '@finclaw/types';
import type { ChartOptions } from './types.js';
import { formatPrice } from './formatters.js';

/** 스파크라인 블록 문자 (하단→상단, 8레벨) */
const SPARK_CHARS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * 과거 데이터를 텍스트 기반 스파크라인 차트로 변환한다.
 * 터미널과 Discord 코드 블록에서 동일하게 렌더링된다.
 *
 * 예시 출력:
 * ```
 * $192.53
 * ▆█▇▅▃▂▃▄▅▆▇█▇▆▅▄▃▃▄▅▆▇█▇▅▃▄▅▆█
 * H: $195.00  L: $185.00  Δ: +3.2%
 * ```
 */
export function generateSparkline(candles: OHLCVCandle[], options: ChartOptions = {}): string {
  const { width = 40, showPrice = true, currency = 'USD' } = options;

  if (candles.length === 0) {
    return '(데이터 없음)';
  }

  // 데이터를 차트 너비에 맞게 리샘플링
  const prices = resample(
    candles.map((c) => c.close),
    width,
  );

  const min = Math.min(...prices);
  const max = Math.max(...prices);
  const range = max - min || 1; // 0 방지

  // 각 가격을 0-8 레벨로 매핑
  const bars = prices.map((price) => {
    const level = Math.round(((price - min) / range) * 8);
    return SPARK_CHARS[Math.min(level, 8)];
  });

  const sparkline = bars.join('');
  const latest = candles[candles.length - 1];
  const first = candles[0];
  const change = ((latest.close - first.close) / first.close) * 100;
  const changeSign = change >= 0 ? '+' : '';

  const lines: string[] = [];

  if (showPrice) {
    // branded CurrencyCode → string: formatPrice는 string을 요구하므로 명시적 캐스트
    lines.push(`${formatPrice(latest.close, currency as string)}`);
  }

  lines.push(sparkline);
  lines.push(
    // branded CurrencyCode → string
    `H: ${formatPrice(max, currency as string)}  L: ${formatPrice(min, currency as string)}  Δ: ${changeSign}${change.toFixed(1)}%`,
  );

  return lines.join('\n');
}

/**
 * 데이터 배열을 targetLength 크기로 리샘플링한다.
 * 데이터가 targetLength보다 길면 평균값 집계를 사용한다.
 */
function resample(data: number[], targetLength: number): number[] {
  if (data.length <= targetLength) {
    return data;
  }

  const result: number[] = [];
  const bucketSize = data.length / targetLength;

  for (let i = 0; i < targetLength; i++) {
    const start = Math.floor(i * bucketSize);
    const end = Math.floor((i + 1) * bucketSize);
    const bucket = data.slice(start, end);
    const avg = bucket.reduce((a, b) => a + b, 0) / bucket.length;
    result.push(avg);
  }

  return result;
}
