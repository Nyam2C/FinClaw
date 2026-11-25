// packages/server/src/composition/local-auth.test.ts
// Phase 46 M10: secret 0600·재사용·env 우선, 토큰 0600·검증 가능, defaultConfig loopback.
import { createHmac } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig } from './constants.js';
import { issueLocalToken, readLocalToken, resolveJwtSecret } from './local-auth.js';

const dir = () => join(homedir(), '.finclaw'); // HOME = tmpdir (test-env.ts)
const mode = (p: string) => statSync(p).mode & 0o777;

beforeEach(() => {
  rmSync(dir(), { recursive: true, force: true });
});

describe('resolveJwtSecret', () => {
  it('env 가 없으면 32바이트 hex secret 을 0600 으로 만들고, 다음 부팅에 재사용', () => {
    const first = resolveJwtSecret({});
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(mode(join(dir(), 'gateway.secret'))).toBe(0o600);
    expect(resolveJwtSecret({})).toBe(first);
  });

  it('GATEWAY_JWT_SECRET 이 우선 — 파일을 만들지 않는다', () => {
    expect(resolveJwtSecret({ GATEWAY_JWT_SECRET: 'from-env' })).toBe('from-env');
    expect(existsSync(join(dir(), 'gateway.secret'))).toBe(false);
  });

  it('빈 GATEWAY_JWT_SECRET 은 미설정으로 본다 [TQ19]', () => {
    expect(resolveJwtSecret({ GATEWAY_JWT_SECRET: '' })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('issueLocalToken / readLocalToken', () => {
  it('0600 토큰 파일, sub=local · exp=+30일 · HS256 서명 검증', () => {
    const now = Date.UTC(2026, 10, 26);
    issueLocalToken('s3cret', now);
    const path = join(dir(), 'gateway.token');
    expect(mode(path)).toBe(0o600);
    const token = readLocalToken() ?? '';
    const [h, p, sig] = token.split('.');
    expect(createHmac('sha256', 's3cret').update(`${h}.${p}`).digest('base64url')).toBe(sig);
    const payload = JSON.parse(Buffer.from(p ?? '', 'base64url').toString('utf8'));
    expect(payload).toEqual({ sub: 'local', exp: now / 1000 + 30 * 24 * 60 * 60 });
    expect(readFileSync(path, 'utf8')).toBe(token);
  });

  it('파일이 없으면 undefined', () => {
    expect(readLocalToken()).toBeUndefined();
  });
});

describe('defaultConfig (B6)', () => {
  it('host 기본 127.0.0.1 · CORS 는 vite 5173 두 origin 만', () => {
    expect(defaultConfig.host).toBe('127.0.0.1');
    expect(defaultConfig.cors?.origins).toEqual(['http://localhost:5173', 'http://127.0.0.1:5173']);
  });
});
