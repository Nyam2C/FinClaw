import type { FinClawLogger } from '@finclaw/infra';
// packages/config/src/types.ts
import type { FinClawConfig } from '@finclaw/types';

/** ConfigDeps -- createConfigIO()에 주입하는 의존성 인터페이스 (sync) */
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
