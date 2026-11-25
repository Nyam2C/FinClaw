// packages/infra/src/paths.ts
import * as os from 'node:os';
import * as path from 'node:path';
import { getEnv } from './env.js';

/** FinClaw 상태 디렉토리 (FINCLAW_STATE_DIR 또는 ~/.finclaw) */
export function getStateDir(): string {
  return getEnv('STATE_DIR') ?? path.join(os.homedir(), '.finclaw');
}

/** 로그 디렉토리 */
export function getLogDir(): string {
  return path.join(getStateDir(), 'logs');
}
