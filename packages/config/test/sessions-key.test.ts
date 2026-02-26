// packages/config/test/sessions-key.test.ts
import { describe, it, expect } from 'vitest';
import { deriveSessionKey } from '../src/sessions/session-key.js';

describe('deriveSessionKey', () => {
  it('scope와 identifier를 결합한다', () => {
    const key = deriveSessionKey('global', 'main');
    expect(key as string).toBe('global:main');
  });

  it('대문자를 소문자로 변환한다', () => {
    const key = deriveSessionKey('channel', 'MyChannel');
    expect(key as string).toBe('channel:mychannel');
  });

  it('특수문자를 _로 치환한다', () => {
    const key = deriveSessionKey('user', 'user@example.com');
    expect(key as string).toBe('user:user_example_com');
  });

  it('연속 _를 하나로 축소한다', () => {
    const key = deriveSessionKey('global', 'a!!b');
    expect(key as string).toBe('global:a_b');
  });

  it('빈 identifier에 default를 사용한다', () => {
    const key = deriveSessionKey('global', '');
    expect(key as string).toBe('global:default');
  });

  it('허용 문자(a-z, 0-9, -, _)는 유지한다', () => {
    const key = deriveSessionKey('user', 'test-user_123');
    expect(key as string).toBe('user:test-user_123');
  });

  it('앞뒤 _를 제거한다', () => {
    const key = deriveSessionKey('channel', '!hello!');
    expect(key as string).toBe('channel:hello');
  });

  it('모든 문자가 비허용이면 default를 사용한다', () => {
    const key = deriveSessionKey('global', '!!!');
    expect(key as string).toBe('global:default');
  });
});
