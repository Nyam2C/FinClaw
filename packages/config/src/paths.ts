// packages/config/src/paths.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * 설정 파일 경로 해석 (JSON5, 자체 구현)
 *
 * 우선순위:
 *   1. FINCLAW_CONFIG 환경변수
 *   2. ~/.finclaw/config/finclaw.json5
 *   3. ./finclaw.json5
 *
 * infra의 getConfigFilePath()는 finclaw.json을 반환하므로 사용하지 않음.
 */
export function resolveConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const envPath = env.FINCLAW_CONFIG;
  if (envPath) {
    return path.resolve(envPath);
  }

  const homePath = path.join(os.homedir(), '.finclaw', 'config', 'finclaw.json5');
  if (fs.existsSync(homePath)) {
    return homePath;
  }

  return path.resolve('finclaw.json5');
}
