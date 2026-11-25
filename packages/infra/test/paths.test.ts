import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getStateDir, getLogDir } from '../src/paths.js';

describe('paths', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it('기본 stateDir은 ~/.finclaw/ 이다', () => {
    expect(getStateDir()).toBe(path.join(os.homedir(), '.finclaw'));
  });

  it('FINCLAW_STATE_DIR 환경 변수로 재정의된다', () => {
    vi.stubEnv('FINCLAW_STATE_DIR', '/tmp/custom');
    expect(getStateDir()).toBe('/tmp/custom');
  });

  it('logDir은 stateDir/logs 이다', () => {
    vi.stubEnv('FINCLAW_STATE_DIR', '/tmp/test');
    expect(getLogDir()).toBe('/tmp/test/logs');
  });
});
