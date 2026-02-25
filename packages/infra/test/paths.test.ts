import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getStateDir, getDataDir, getLogDir, getConfigDir, getAllPaths } from '../src/paths.js';

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

  it('dataDir은 stateDir/data 이다', () => {
    vi.stubEnv('FINCLAW_STATE_DIR', '/tmp/test');
    expect(getDataDir()).toBe('/tmp/test/data');
  });

  it('logDir은 stateDir/logs 이다', () => {
    vi.stubEnv('FINCLAW_STATE_DIR', '/tmp/test');
    expect(getLogDir()).toBe('/tmp/test/logs');
  });

  it('configDir은 stateDir/config 이다', () => {
    vi.stubEnv('FINCLAW_STATE_DIR', '/tmp/test');
    expect(getConfigDir()).toBe('/tmp/test/config');
  });

  it('getAllPaths는 모든 경로를 반환한다', () => {
    vi.stubEnv('FINCLAW_STATE_DIR', '/tmp/test');
    const paths = getAllPaths();
    expect(paths.stateDir).toBe('/tmp/test');
    expect(paths.dataDir).toBe('/tmp/test/data');
    expect(paths.logDir).toBe('/tmp/test/logs');
    expect(paths.configDir).toBe('/tmp/test/config');
    expect(Object.keys(paths)).toHaveLength(7);
  });
});
