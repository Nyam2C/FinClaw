// packages/infra/src/paths.ts
import * as os from 'node:os';
import * as path from 'node:path';
import { getEnv } from './env.js';

/** 기본 상태 디렉토리 */
function defaultStateDir(): string {
  return path.join(os.homedir(), '.finclaw');
}

/** FinClaw 상태 디렉토리 (데이터/설정/로그의 루트) */
export function getStateDir(): string {
  return getEnv('STATE_DIR') ?? defaultStateDir();
}

/** 데이터 디렉토리 */
export function getDataDir(): string {
  return path.join(getStateDir(), 'data');
}

/** 설정 디렉토리 */
export function getConfigDir(): string {
  return path.join(getStateDir(), 'config');
}

/** 로그 디렉토리 */
export function getLogDir(): string {
  return path.join(getStateDir(), 'logs');
}

/** 세션 디렉토리 */
export function getSessionDir(): string {
  return path.join(getStateDir(), 'sessions');
}

/** 잠금 파일 디렉토리 */
export function getLockDir(): string {
  return path.join(getStateDir(), 'locks');
}

/** 설정 파일 경로 */
export function getConfigFilePath(): string {
  return path.join(getConfigDir(), 'finclaw.json');
}

/**
 * 모든 경로를 한번에 반환 (디버깅/로깅용)
 */
export function getAllPaths(): Record<string, string> {
  return {
    stateDir: getStateDir(),
    dataDir: getDataDir(),
    configDir: getConfigDir(),
    logDir: getLogDir(),
    sessionDir: getSessionDir(),
    lockDir: getLockDir(),
    configFile: getConfigFilePath(),
  };
}
