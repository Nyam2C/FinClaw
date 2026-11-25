// packages/server/src/composition/local-auth.ts
// Phase 46 M10 (B6/B10): gateway JWT secret 해석·영속 + 로컬 토큰 파일 발급. 토큰·secret 은 로그에 남기지 않는다.
import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { signToken } from '@finclaw/gateway';

/** D7: sessionTtlMs(30분)는 로컬 토큰에 짧다 → 30일, 부팅마다 재발급. */
const LOCAL_TOKEN_TTL_S = 30 * 24 * 60 * 60;

const finclawDir = (): string => join(homedir(), '.finclaw');
const secretPath = (): string => join(finclawDir(), 'gateway.secret');
const tokenPath = (): string => join(finclawDir(), 'gateway.token');

/**
 * `GATEWAY_JWT_SECRET` 우선. 비었거나 없으면 `~/.finclaw/gateway.secret`
 * (최초 1회 32바이트 hex 생성, 0600, 이후 재사용). [TQ19] 빈 문자열은 미설정으로 본다 — 빈 secret 이면 토큰 위조가 가능.
 */
export function resolveJwtSecret(env: NodeJS.ProcessEnv = process.env): string {
  if (env.GATEWAY_JWT_SECRET) {
    return env.GATEWAY_JWT_SECRET;
  }
  const existing = readOptional(secretPath());
  if (existing) {
    return existing;
  }
  const secret = randomBytes(32).toString('hex');
  writePrivate(secretPath(), secret);
  return secret;
}

/** 부팅마다 `{sub:'local', exp: now+30일}` 토큰을 `~/.finclaw/gateway.token`(0600) 에 재기록. */
export function issueLocalToken(secret: string, nowMs: number = Date.now()): void {
  writePrivate(
    tokenPath(),
    signToken({ sub: 'local', exp: Math.floor(nowMs / 1000) + LOCAL_TOKEN_TTL_S }, secret),
  );
}

/** TUI·CLI 용 — 파일이 없으면 undefined. */
export function readLocalToken(): string | undefined {
  return readOptional(tokenPath());
}

function readOptional(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function writePrivate(path: string, content: string): void {
  mkdirSync(finclawDir(), { recursive: true });
  // 이미 있던 파일은 writeFileSync 의 mode 가 적용되지 않는다 → 내용을 쓰기 전에 좁힌다 (느슨한 권한으로 새 값이 보이는 창 없음)
  if (existsSync(path)) {
    chmodSync(path, 0o600);
  }
  writeFileSync(path, content, { mode: 0o600 });
}
