import { describe, it, expect } from 'vitest';
import { ConcurrencyLane, ConcurrencyLaneManager } from '../src/concurrency-lane.js';

describe('ConcurrencyLane', () => {
  it('maxConcurrent 이내에서 즉시 acquire 가능', async () => {
    const lane = new ConcurrencyLane({ maxConcurrent: 2 });
    const h1 = await lane.acquire('k');
    const h2 = await lane.acquire('k');
    expect(lane.getActiveCount('k')).toBe(2);
    h1.release();
    h2.release();
  });

  it('maxConcurrent 초과 시 대기하다 release 후 진행', async () => {
    const lane = new ConcurrencyLane({ maxConcurrent: 1 });
    const h1 = await lane.acquire('k');
    expect(lane.getActiveCount('k')).toBe(1);

    let resolved = false;
    const p2 = lane.acquire('k').then((h) => {
      resolved = true;
      return h;
    });
    // 아직 대기 중
    await Promise.resolve();
    expect(lane.getWaitingCount('k')).toBe(1);

    h1.release();
    const h2 = await p2;
    expect(resolved).toBe(true);
    h2.release();
  });

  it('maxQueueSize 초과 시 LANE_QUEUE_FULL 에러', async () => {
    const lane = new ConcurrencyLane({ maxConcurrent: 1, maxQueueSize: 1 });
    await lane.acquire('k');
    // 큐에 1개 대기 — catch로 타임아웃 reject 방지
    const p1 = lane.acquire('k').catch(() => {});
    // 큐에 2번째 → 에러
    await expect(lane.acquire('k')).rejects.toThrow('Concurrency lane queue full');
    lane.dispose();
    await p1;
  });

  it('resetGeneration 후 stale release는 무시됨', async () => {
    const lane = new ConcurrencyLane({ maxConcurrent: 1 });
    const h1 = await lane.acquire('k');
    expect(lane.getActiveCount('k')).toBe(1);

    lane.resetGeneration();
    h1.release(); // stale — 무시
    // active count는 여전히 1 (stale release 무시)
    expect(lane.getActiveCount('k')).toBe(1);
  });

  it('clearWaiters가 대기 중인 모든 waiter를 reject', async () => {
    const lane = new ConcurrencyLane({ maxConcurrent: 1 });
    await lane.acquire('k');
    const p = lane.acquire('k');

    lane.clearWaiters();
    await expect(p).rejects.toThrow('Lane cleared');
  });

  it('dispose 후 active와 waiters 모두 정리', async () => {
    const lane = new ConcurrencyLane({ maxConcurrent: 1 });
    await lane.acquire('k');
    const p = lane.acquire('k').catch(() => {}); // catch to prevent unhandled rejection

    lane.dispose();
    await p;
    expect(lane.getActiveCount('k')).toBe(0);
    expect(lane.getWaitingCount('k')).toBe(0);
  });

  it('다른 키는 독립적으로 관리', async () => {
    const lane = new ConcurrencyLane({ maxConcurrent: 1 });
    const h1 = await lane.acquire('a');
    const h2 = await lane.acquire('b');
    expect(lane.getActiveCount('a')).toBe(1);
    expect(lane.getActiveCount('b')).toBe(1);
    h1.release();
    h2.release();
  });
});

describe('ConcurrencyLaneManager', () => {
  it('3-Lane 기본 설정으로 생성', () => {
    const mgr = new ConcurrencyLaneManager();
    // main(1), cron(2), subagent(3) 기본 설정
    expect(mgr).toBeDefined();
  });

  it('존재하지 않는 레인 접근 시 UNKNOWN_LANE 에러', () => {
    const mgr = new ConcurrencyLaneManager();
    // @ts-expect-error -- 잘못된 레인 ID 테스트
    expect(() => mgr.acquire('invalid', 'k')).toThrow('Unknown lane: invalid');
  });

  it('dispose가 모든 레인을 정리', async () => {
    const mgr = new ConcurrencyLaneManager();
    await mgr.acquire('main', 'k');
    mgr.dispose();
    // dispose 후에는 정리 완료 (에러 없이 통과하면 성공)
  });
});
