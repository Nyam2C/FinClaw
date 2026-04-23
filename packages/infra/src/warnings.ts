// packages/infra/src/warnings.ts

const emitted = new Set<string>();

/**
 * 중복 경고 억제 래퍼
 *
 * 동일 key로 호출 시 최초 1회만 fn 실행.
 */
export function warnOnce(key: string, fn: () => void): void {
  if (emitted.has(key)) {
    return;
  }
  emitted.add(key);
  fn();
}

/**
 * 테스트 전용: 중복 경고 억제 상태(emitted Set)를 초기화한다.
 * 프로덕션 코드에서 호출하지 말 것.
 * @internal
 */
export function resetWarnings(): void {
  emitted.clear();
}
