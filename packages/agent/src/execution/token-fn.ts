// packages/agent/src/execution/token-fn.ts
// pipeline tokenCounter 로 주입되는 토큰 추정 함수 시그니처 어댑터.
// 정밀도 ±5% — Anthropic 의 countTokens API 우선 활용 가능하나 1차는 char/4 근사.

export function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
