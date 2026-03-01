import { describe, it, expect, beforeEach } from 'vitest';
import type { StreamState, StreamEvent } from '../src/execution/streaming.js';
import { StreamStateMachine } from '../src/execution/streaming.js';

describe('StreamStateMachine', () => {
  let sm: StreamStateMachine;

  beforeEach(() => {
    sm = new StreamStateMachine();
  });

  it('초기 상태는 idle이다', () => {
    expect(sm.currentState).toBe('idle');
  });

  describe('허용된 전이', () => {
    it('idle → streaming', () => {
      sm.transition('streaming');
      expect(sm.currentState).toBe('streaming');
    });

    it('streaming → tool_use', () => {
      sm.transition('streaming');
      sm.transition('tool_use');
      expect(sm.currentState).toBe('tool_use');
    });

    it('streaming → done', () => {
      sm.transition('streaming');
      sm.transition('done');
      expect(sm.currentState).toBe('done');
    });

    it('tool_use → executing', () => {
      sm.transition('streaming');
      sm.transition('tool_use');
      sm.transition('executing');
      expect(sm.currentState).toBe('executing');
    });

    it('executing → streaming (다음 턴)', () => {
      sm.transition('streaming');
      sm.transition('tool_use');
      sm.transition('executing');
      sm.transition('streaming');
      expect(sm.currentState).toBe('streaming');
    });

    it('executing → done', () => {
      sm.transition('streaming');
      sm.transition('tool_use');
      sm.transition('executing');
      sm.transition('done');
      expect(sm.currentState).toBe('done');
    });

    it('done → idle (리셋)', () => {
      sm.transition('streaming');
      sm.transition('done');
      sm.transition('idle');
      expect(sm.currentState).toBe('idle');
    });
  });

  describe('금지된 전이', () => {
    it.each([
      ['idle', 'tool_use'],
      ['idle', 'executing'],
      ['idle', 'done'],
      ['streaming', 'idle'],
      ['streaming', 'executing'],
      ['tool_use', 'idle'],
      ['tool_use', 'streaming'],
      ['tool_use', 'done'],
      ['executing', 'idle'],
      ['executing', 'tool_use'],
      ['done', 'streaming'],
      ['done', 'tool_use'],
      ['done', 'executing'],
      ['done', 'done'],
    ] as [StreamState, StreamState][])('%s → %s는 에러를 던진다', (from, to) => {
      // from 상태까지 이동
      const paths: Record<StreamState, StreamState[]> = {
        idle: [],
        streaming: ['streaming'],
        tool_use: ['streaming', 'tool_use'],
        executing: ['streaming', 'tool_use', 'executing'],
        done: ['streaming', 'done'],
      };
      for (const step of paths[from]) {
        sm.transition(step);
      }
      expect(() => sm.transition(to)).toThrow(/Invalid state transition/);
    });
  });

  describe('이벤트 발행', () => {
    it('전이 시 state_change 이벤트를 발행한다', () => {
      const events: StreamEvent[] = [];
      sm.on((e) => events.push(e));

      sm.transition('streaming');
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'state_change', from: 'idle', to: 'streaming' });
    });

    it('emit()으로 임의 이벤트를 발행할 수 있다', () => {
      const events: StreamEvent[] = [];
      sm.on((e) => events.push(e));

      sm.emit({ type: 'text_delta', delta: 'hello' });
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({ type: 'text_delta', delta: 'hello' });
    });

    it('on()이 반환한 함수로 리스너를 해제한다', () => {
      const events: StreamEvent[] = [];
      const off = sm.on((e) => events.push(e));

      sm.transition('streaming');
      expect(events).toHaveLength(1);

      off();
      sm.transition('done');
      expect(events).toHaveLength(1); // 추가 이벤트 없음
    });
  });

  describe('reset()', () => {
    it('상태를 idle로 리셋한다', () => {
      sm.transition('streaming');
      sm.transition('done');
      sm.reset();
      expect(sm.currentState).toBe('idle');
    });

    it('리셋 후 idle에서 다시 시작할 수 있다', () => {
      sm.transition('streaming');
      sm.transition('done');
      sm.reset();
      sm.transition('streaming'); // idle → streaming
      expect(sm.currentState).toBe('streaming');
    });
  });
});
