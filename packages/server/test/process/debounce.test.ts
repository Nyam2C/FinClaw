import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createDebouncer } from '../../src/process/debounce.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('createDebouncer', () => {
  it('윈도우 내 마지막 값만 handler에 전달', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const d = createDebouncer(handler, { windowMs: 100 });

    d.push('k', 'a');
    d.push('k', 'b');
    d.push('k', 'c');

    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('k', 'c');
    d.destroy();
  });

  it('윈도우 리셋: push마다 타이머 재시작', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const d = createDebouncer(handler, { windowMs: 100 });

    d.push('k', 'a');
    await vi.advanceTimersByTimeAsync(80);
    d.push('k', 'b'); // 타이머 리셋

    await vi.advanceTimersByTimeAsync(80);
    expect(handler).not.toHaveBeenCalled(); // 아직 100ms 안 됨

    await vi.advanceTimersByTimeAsync(20);
    expect(handler).toHaveBeenCalledWith('k', 'b');
    d.destroy();
  });

  it('maxWait로 무한 지연 방지', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const d = createDebouncer(handler, { windowMs: 100, maxWaitMs: 250 });

    // 80ms마다 push → 윈도우 계속 리셋되지만 maxWait에 도달
    d.push('k', 'v0');
    await vi.advanceTimersByTimeAsync(80);
    d.push('k', 'v1');
    await vi.advanceTimersByTimeAsync(80);
    d.push('k', 'v2');
    await vi.advanceTimersByTimeAsync(80);
    // 240ms 경과, maxWait=250 → 10ms 후 강제 fire
    d.push('k', 'v3');
    await vi.advanceTimersByTimeAsync(10);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith('k', 'v3');
    d.destroy();
  });

  it('flush가 즉시 handler 호출', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const d = createDebouncer(handler, { windowMs: 1000 });

    d.push('k', 'val');
    d.flush('k');

    expect(handler).toHaveBeenCalledWith('k', 'val');
    d.destroy();
  });

  it('flush 후 타이머에 의한 중복 호출 없음', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const d = createDebouncer(handler, { windowMs: 100 });

    d.push('k', 'val');
    d.flush('k');
    await vi.advanceTimersByTimeAsync(200);

    expect(handler).toHaveBeenCalledTimes(1);
    d.destroy();
  });

  it('키별 독립 동작', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const d = createDebouncer(handler, { windowMs: 100 });

    d.push('a', '1');
    d.push('b', '2');
    await vi.advanceTimersByTimeAsync(100);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler).toHaveBeenCalledWith('a', '1');
    expect(handler).toHaveBeenCalledWith('b', '2');
    d.destroy();
  });

  it('destroy 후 pending 타이머 실행 안 됨', async () => {
    const handler = vi.fn().mockResolvedValue(undefined);
    const d = createDebouncer(handler, { windowMs: 100 });

    d.push('k', 'val');
    d.destroy();
    await vi.advanceTimersByTimeAsync(200);

    expect(handler).not.toHaveBeenCalled();
  });

  it('onError 콜백이 handler rejection을 받음', async () => {
    const onError = vi.fn();
    const error = new Error('handler failed');
    const handler = vi.fn().mockRejectedValue(error);
    const d = createDebouncer(handler, { windowMs: 100, onError });

    d.push('k', 'val');
    await vi.advanceTimersByTimeAsync(100);
    // microtask flush
    await vi.advanceTimersByTimeAsync(0);

    expect(onError).toHaveBeenCalledWith(error);
    d.destroy();
  });
});
