import { describe, it, expect } from 'vitest';
import { MissingEnvError, requireEnv } from './main.js';

describe('requireEnv', () => {
  it('env에 값이 있으면 반환한다', () => {
    const env = { FOO: 'bar' };
    expect(requireEnv('FOO', env)).toBe('bar');
  });

  it('값이 없으면 MissingEnvError throw', () => {
    const env = {};
    expect(() => requireEnv('ANTHROPIC_API_KEY', env)).toThrow(MissingEnvError);
    try {
      requireEnv('ANTHROPIC_API_KEY', env);
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEnvError);
      expect((err as MissingEnvError).envName).toBe('ANTHROPIC_API_KEY');
    }
  });

  it('값이 빈 문자열이어도 throw', () => {
    const env = { DISCORD_BOT_TOKEN: '' };
    expect(() => requireEnv('DISCORD_BOT_TOKEN', env)).toThrow(MissingEnvError);
  });
});
