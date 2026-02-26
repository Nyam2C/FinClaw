// packages/config/test/env-substitution.test.ts
import { describe, it, expect } from 'vitest';
import { resolveEnvVars } from '../src/env-substitution.js';
import { MissingEnvVarError } from '../src/errors.js';

describe('resolveEnvVars', () => {
  const env = {
    API_KEY: 'secret123',
    HOST: 'localhost',
    PORT: '8080',
  } as NodeJS.ProcessEnv;

  it('${VAR}를 치환한다', () => {
    expect(resolveEnvVars('${API_KEY}', env)).toBe('secret123');
  });

  it('문자열 내 여러 변수를 치환한다', () => {
    expect(resolveEnvVars('http://${HOST}:${PORT}', env)).toBe('http://localhost:8080');
  });

  it('$가 없으면 그대로 반환한다', () => {
    expect(resolveEnvVars('no vars here', env)).toBe('no vars here');
  });

  it('소문자 변수를 무시한다', () => {
    expect(resolveEnvVars('${lower}', env)).toBe('${lower}');
  });

  it('미설정 변수에 MissingEnvVarError를 throw한다', () => {
    expect(() => resolveEnvVars('${MISSING_VAR}', env)).toThrow(MissingEnvVarError);
  });

  it('빈 문자열 변수에 MissingEnvVarError를 throw한다', () => {
    const envWithEmpty = { EMPTY: '' } as NodeJS.ProcessEnv;
    expect(() => resolveEnvVars('${EMPTY}', envWithEmpty)).toThrow(MissingEnvVarError);
  });

  it('$${VAR} escape를 리터럴 ${VAR}로 출력한다', () => {
    expect(resolveEnvVars('$${API_KEY}', env)).toBe('${API_KEY}');
  });

  it('객체를 재귀적으로 치환한다', () => {
    const input = { host: '${HOST}', nested: { port: '${PORT}' } };
    expect(resolveEnvVars(input, env)).toEqual({
      host: 'localhost',
      nested: { port: '8080' },
    });
  });

  it('배열을 재귀적으로 치환한다', () => {
    expect(resolveEnvVars(['${HOST}', '${PORT}'], env)).toEqual(['localhost', '8080']);
  });

  it('숫자/불리언 등 비문자열은 그대로 반환한다', () => {
    expect(resolveEnvVars(42, env)).toBe(42);
    expect(resolveEnvVars(true, env)).toBe(true);
    expect(resolveEnvVars(null, env)).toBe(null);
  });
});
