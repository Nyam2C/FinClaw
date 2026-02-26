// packages/infra/src/is-main.ts

/**
 * ESM 엔트리포인트 판별
 *
 * `import.meta.url`과 `process.argv[1]`을 비교하여
 * 현재 모듈이 직접 실행되었는지 판별.
 */
export function isMain(importMetaUrl: string): boolean {
  try {
    const moduleUrl = new URL(importMetaUrl);
    const argUrl = new URL(`file://${process.argv[1]}`);
    return moduleUrl.pathname === argUrl.pathname;
  } catch {
    return false;
  }
}
