// packages/agent/src/execution/token-fn.ts
// compactContext 의 tokenCounter 인자로 주입되는 함수 시그니처 어댑터.
// 정밀도 ±5% — Anthropic 의 countTokens API 우선 활용 가능하나 1차는 char/4 근사.

export function approxTokenCount(text: string): number {
  return Math.ceil(text.length / 4);
}
