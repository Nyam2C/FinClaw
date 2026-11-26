// packages/config/test/example.test.ts — 루트 config.example.json5 가 strict 스키마를 통과하는지.
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { createConfigIO } from '../src/io.js';
import { validateConfigStrict } from '../src/validation.js';

const EXAMPLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../config.example.json5',
);

describe('config.example.json5', () => {
  it('로드 + validateConfigStrict 를 통과한다', () => {
    const config = createConfigIO({ configPath: EXAMPLE, env: {} }).loadConfig();
    expect(() => validateConfigStrict(config)).not.toThrow();
    expect(config.rag?.rerank?.enabled).toBe(true);
    expect(config.provider).toBeUndefined(); // 예전 키(`provider`·`cliBackend`)는 허용만 하고 예시에서는 뺐다
  });
});
