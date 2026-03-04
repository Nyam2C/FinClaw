import { getEventBus } from '@finclaw/infra';
import { watch, type FSWatcher } from 'chokidar';
// packages/server/src/gateway/hot-reload.ts
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { GatewayServerContext } from './context.js';
import type { ConfigChangeEvent } from './rpc/types.js';

export interface HotReloadConfig {
  readonly configPath: string;
  readonly debounceMs: number;
  readonly validateBeforeApply: boolean;
  readonly mode: 'watch' | 'poll';
}

export interface HotReloadManager {
  start(): Promise<void>;
  stop(): void;
  on(event: 'change', listener: (e: ConfigChangeEvent) => void): void;
  on(event: 'error', listener: (e: Error) => void): void;
}

export function createHotReloader(
  config: HotReloadConfig,
  ctx: GatewayServerContext,
  validate: (content: string) => { success: boolean; error?: string },
): HotReloadManager {
  let watcher: FSWatcher | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let lastHash = '';

  const listeners = {
    change: new Set<(e: ConfigChangeEvent) => void>(),
    error: new Set<(e: Error) => void>(),
  };

  async function computeHash(filePath: string): Promise<string> {
    const content = await readFile(filePath, 'utf8');
    return createHash('sha256').update(content).digest('hex');
  }

  function handleChange(filePath: string): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(async () => {
      try {
        const content = await readFile(filePath, 'utf8');
        const currentHash = createHash('sha256').update(content).digest('hex');

        if (currentHash === lastHash) {
          return;
        }

        if (config.validateBeforeApply) {
          const result = validate(content);
          if (!result.success) {
            for (const listener of listeners.error) {
              listener(new Error(`Config validation failed: ${result.error}`));
            }
            return;
          }
        }

        const event: ConfigChangeEvent = {
          path: filePath,
          changeType: 'modified',
          timestamp: Date.now(),
          previousHash: lastHash,
          currentHash,
        };

        lastHash = currentHash;

        for (const listener of listeners.change) {
          listener(event);
        }

        getEventBus().emit('config:change', [filePath]);

        ctx.broadcaster.broadcastToChannel(ctx.connections, 'config.updated', {
          path: filePath,
          timestamp: event.timestamp,
        });
      } catch (error) {
        for (const listener of listeners.error) {
          listener(error as Error);
        }
      }
    }, config.debounceMs);
  }

  return {
    async start(): Promise<void> {
      try {
        lastHash = await computeHash(config.configPath);
      } catch {
        lastHash = '';
      }

      const usePolling = config.mode === 'poll';

      watcher = watch(config.configPath, {
        persistent: true,
        ignoreInitial: true,
        usePolling,
        awaitWriteFinish: { stabilityThreshold: 200 },
      });

      watcher.on('change', handleChange);
      watcher.on('error', (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        for (const listener of listeners.error) {
          listener(error);
        }
      });
    },

    stop(): void {
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      watcher?.close();
      watcher = null;
    },

    on(
      event: 'change' | 'error',
      listener: ((e: ConfigChangeEvent) => void) | ((e: Error) => void),
    ) {
      if (event === 'change') {
        listeners.change.add(listener as (e: ConfigChangeEvent) => void);
      } else if (event === 'error') {
        listeners.error.add(listener as (e: Error) => void);
      }
    },
  };
}
