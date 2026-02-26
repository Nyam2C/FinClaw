import * as fs from 'node:fs/promises';
// packages/config/test/paths.test.ts
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { resolveConfigPath } from '../src/paths.js';

describe('resolveConfigPath', () => {
  it('FINCLAW_CONFIG 환경변수가 최우선이다', () => {
    const env = { FINCLAW_CONFIG: '/custom/config.json5' } as NodeJS.ProcessEnv;
    expect(resolveConfigPath(env)).toBe('/custom/config.json5');
  });

  it('환경변수 없으면 ~/.finclaw/config/finclaw.json5를 탐색한다', async () => {
    const home = os.homedir();
    const homePath = path.join(home, '.finclaw', 'config', 'finclaw.json5');

    // 파일이 존재하면 해당 경로 반환, 없으면 ./finclaw.json5
    const result = resolveConfigPath({} as NodeJS.ProcessEnv);
    const expected = await fs
      .access(homePath)
      .then(() => homePath)
      .catch(() => path.resolve('finclaw.json5'));
    expect(result).toBe(expected);
  });

  it('환경변수도 홈경로도 없으면 ./finclaw.json5를 반환한다', () => {
    const result = resolveConfigPath({} as NodeJS.ProcessEnv);
    // HOME이 tmpDir로 격리되어 있으므로 ./finclaw.json5
    expect(result).toBe(path.resolve('finclaw.json5'));
  });
});
