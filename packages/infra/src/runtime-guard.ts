// packages/infra/src/runtime-guard.ts
const MINIMUM_NODE_VERSION = 22;

/**
 * Node.js 버전 검증
 *
 * 22 미만이면 에러 메시지 출력 후 process.exit(1).
 * 테스트에서는 process.exit를 spy하여 호출 여부만 확인.
 */
export function assertSupportedRuntime(): void {
  const [major] = process.versions.node.split('.').map(Number);
  if (major < MINIMUM_NODE_VERSION) {
    console.error(
      `FinClaw requires Node.js ${MINIMUM_NODE_VERSION} or later.\n` +
        `Current version: ${process.versions.node}\n` +
        `Install: https://nodejs.org/`,
    );
    process.exit(1);
  }
}

/** 현재 Node.js 메이저 버전 반환 (테스트 보조) */
export function getNodeMajorVersion(): number {
  return Number(process.versions.node.split('.')[0]);
}
