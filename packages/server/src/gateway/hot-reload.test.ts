// packages/server/src/gateway/hot-reload.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// chokidar를 mock
vi.mock('chokidar', () => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  return {
    watch: vi.fn().mockReturnValue({
      on(event: string, handler: (...args: unknown[]) => void) {
        handlers.set(event, handler);
        return this;
      },
      close: vi.fn(),
      _trigger(event: string, ...args: unknown[]) {
        handlers.get(event)?.(...args);
      },
      _handlers: handlers,
    }),
  };
});

vi.mock('node:fs/promises', () => ({
  readFile: vi.fn(),
}));

vi.mock('@finclaw/infra', () => ({
  getEventBus: vi.fn().mockReturnValue({
    emit: vi.fn(),
  }),
}));

import { getEventBus } from '@finclaw/infra';
import { watch } from 'chokidar';
import { readFile } from 'node:fs/promises';
import type { GatewayServerContext } from './context.js';
import { createHotReloader, type HotReloadConfig } from './hot-reload.js';

describe('HotReloadManager', () => {
  const defaultConfig: HotReloadConfig = {
    configPath: '/app/config.json',
    debounceMs: 50,
    validateBeforeApply: true,
    mode: 'watch',
  };

  let ctx: GatewayServerContext;
  let validate: ReturnType<typeof vi.fn<(content: string) => { success: boolean; error?: string }>>;

  beforeEach(() => {
    vi.useFakeTimers();
    validate = vi
      .fn<(content: string) => { success: boolean; error?: string }>()
      .mockReturnValue({ success: true });

    ctx = {
      broadcaster: { broadcastToChannel: vi.fn().mockReturnValue(1) },
      connections: new Map(),
    } as unknown as GatewayServerContext;

    (readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('{"port": 3000}');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('start()에서 초기 해시 계산', async () => {
    const reloader = createHotReloader(defaultConfig, ctx, validate);
    await reloader.start();

    expect(readFile).toHaveBeenCalledWith('/app/config.json', 'utf8');
    reloader.stop();
  });

  it('파일 변경 시 change 리스너 호출', async () => {
    const onChange = vi.fn();
    const reloader = createHotReloader(defaultConfig, ctx, validate);
    reloader.on('change', onChange);
    await reloader.start();

    // 파일 내용 변경
    (readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('{"port": 4000}');

    // chokidar change 이벤트 시뮬레이션
    const watcher = (watch as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    watcher._trigger('change', '/app/config.json');

    // debounce 대기
    await vi.advanceTimersByTimeAsync(defaultConfig.debounceMs + 10);

    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange.mock.calls[0][0]).toMatchObject({
      path: '/app/config.json',
      changeType: 'modified',
    });

    reloader.stop();
  });

  it('동일 해시면 change 리스너 미호출', async () => {
    const onChange = vi.fn();
    const reloader = createHotReloader(defaultConfig, ctx, validate);
    reloader.on('change', onChange);
    await reloader.start();

    // 동일 내용 (해시 불변)
    const watcher = (watch as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    watcher._trigger('change', '/app/config.json');
    await vi.advanceTimersByTimeAsync(defaultConfig.debounceMs + 10);

    expect(onChange).not.toHaveBeenCalled();
    reloader.stop();
  });

  it('validate 실패 시 error 리스너 호출', async () => {
    validate.mockReturnValue({ success: false, error: 'Invalid port' });
    const onError = vi.fn();

    const reloader = createHotReloader(defaultConfig, ctx, validate);
    reloader.on('error', onError);
    await reloader.start();

    (readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('{"port": "bad"}');
    const watcher = (watch as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    watcher._trigger('change', '/app/config.json');
    await vi.advanceTimersByTimeAsync(defaultConfig.debounceMs + 10);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0].message).toContain('Config validation failed');
    reloader.stop();
  });

  it('변경 시 eventBus emit + broadcastToChannel 호출', async () => {
    const reloader = createHotReloader(defaultConfig, ctx, validate);
    await reloader.start();

    (readFile as unknown as ReturnType<typeof vi.fn>).mockResolvedValue('{"port": 5000}');
    const watcher = (watch as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    watcher._trigger('change', '/app/config.json');
    await vi.advanceTimersByTimeAsync(defaultConfig.debounceMs + 10);

    expect(getEventBus().emit).toHaveBeenCalledWith('config:change', ['/app/config.json']);
    expect(ctx.broadcaster.broadcastToChannel).toHaveBeenCalledWith(
      ctx.connections,
      'config.updated',
      expect.objectContaining({ path: '/app/config.json' }),
    );
    reloader.stop();
  });

  it('debounce: 연속 변경 시 마지막 1회만 처리', async () => {
    const onChange = vi.fn();
    const reloader = createHotReloader(defaultConfig, ctx, validate);
    reloader.on('change', onChange);
    await reloader.start();

    let counter = 0;
    (readFile as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => `{"v": ${++counter}}`,
    );

    const watcher = (watch as unknown as ReturnType<typeof vi.fn>).mock.results[0].value;
    watcher._trigger('change', '/app/config.json');
    await vi.advanceTimersByTimeAsync(10);
    watcher._trigger('change', '/app/config.json');
    await vi.advanceTimersByTimeAsync(10);
    watcher._trigger('change', '/app/config.json');
    await vi.advanceTimersByTimeAsync(defaultConfig.debounceMs + 10);

    expect(onChange).toHaveBeenCalledTimes(1);
    reloader.stop();
  });

  it('poll 모드 설정 전달', async () => {
    const pollConfig = { ...defaultConfig, mode: 'poll' as const };
    const reloader = createHotReloader(pollConfig, ctx, validate);
    await reloader.start();

    expect(watch).toHaveBeenCalledWith(
      '/app/config.json',
      expect.objectContaining({
        usePolling: true,
      }),
    );
    reloader.stop();
  });
});
