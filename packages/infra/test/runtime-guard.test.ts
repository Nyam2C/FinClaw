import { describe, it, expect, vi } from 'vitest';
import { assertSupportedRuntime, getNodeMajorVersion } from '../src/runtime-guard.js';

describe('assertSupportedRuntime', () => {
  it('Node 22+에서 정상 통과한다', () => {
    // 현재 환경이 22+이므로 exit 호출 없음
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    assertSupportedRuntime();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

describe('getNodeMajorVersion', () => {
  it('현재 Node 메이저 버전을 반환한다', () => {
    const major = getNodeMajorVersion();
    expect(major).toBeGreaterThanOrEqual(22);
    expect(typeof major).toBe('number');
  });
});
