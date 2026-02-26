import type { FinClawLogger } from '@finclaw/infra';
// packages/config/src/types.ts
import type { FinClawConfig } from '@finclaw/types';

/**
 * ConfigDeps -- createConfigIO()에 주입하는 의존성 인터페이스
 *
 * Phase 1 @finclaw/types의 ConfigIoDeps(async)와 이름 충돌 방지를 위해
 * config 패키지 내부 타입으로 분리. 이 인터페이스는 sync 메서드 사용.
 */
export interface ConfigDeps {
  fs?: typeof import('node:fs');
  json5?: { parse(text: string): unknown };
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  configPath?: string;
  logger?: Pick<FinClawLogger, 'error' | 'warn' | 'info' | 'debug'>;
}

/** TTL 캐시 내부 상태 */
export interface ConfigCache {
  config: FinClawConfig | null;
  expireAt: number;
  mtime: number;
  isValid(): boolean;
  get(): FinClawConfig | null;
  set(config: FinClawConfig): void;
  invalidate(): void;
}
