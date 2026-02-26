// packages/config/src/cache-utils.ts
import type { FinClawConfig } from '@finclaw/types';
import type { ConfigCache } from './types.js';

const DEFAULT_TTL_MS = 200;

/** TTL 캐시 생성 */
export function createConfigCache(ttlMs = DEFAULT_TTL_MS): ConfigCache {
  let config: FinClawConfig | null = null;
  let expireAt = 0;
  let mtime = 0;

  return {
    get config() {
      return config;
    },
    get expireAt() {
      return expireAt;
    },
    get mtime() {
      return mtime;
    },

    isValid(): boolean {
      return config !== null && Date.now() < expireAt;
    },

    get(): FinClawConfig | null {
      if (this.isValid()) {
        return config;
      }
      return null;
    },

    set(newConfig: FinClawConfig): void {
      config = newConfig;
      expireAt = Date.now() + ttlMs;
      mtime = Date.now();
    },

    invalidate(): void {
      config = null;
      expireAt = 0;
    },
  };
}
