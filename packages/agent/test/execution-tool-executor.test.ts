import type { ToolCall } from '@finclaw/types';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ToolHandler } from '../src/execution/tool-executor.js';
import { ExecutionToolDispatcher } from '../src/execution/tool-executor.js';

describe('ExecutionToolDispatcher', () => {
  let dispatcher: ExecutionToolDispatcher;

  beforeEach(() => {
    dispatcher = new ExecutionToolDispatcher();
  });

  describe('register / unregister / has', () => {
    it('핸들러를 등록하고 존재 여부를 확인한다', () => {
      const handler: ToolHandler = { execute: async () => 'ok' };
      dispatcher.register('test_tool', handler);
      expect(dispatcher.has('test_tool')).toBe(true);
      expect(dispatcher.has('unknown')).toBe(false);
    });

    it('핸들러를 해제한다', () => {
      dispatcher.register('test_tool', { execute: async () => 'ok' });
      expect(dispatcher.unregister('test_tool')).toBe(true);
      expect(dispatcher.has('test_tool')).toBe(false);
    });

    it('미등록 핸들러 해제 시 false 반환', () => {
      expect(dispatcher.unregister('nonexistent')).toBe(false);
    });
  });

  describe('executeSingle (executeAll 경유)', () => {
    it('등록된 도구를 실행하고 결과를 반환한다', async () => {
      dispatcher.register('get_price', {
        execute: async (input) => {
          const { ticker } = input as { ticker: string };
          return `${ticker}: 50000`;
        },
      });

      const results = await dispatcher.executeAll([
        { id: 'call_1', name: 'get_price', input: { ticker: 'AAPL' } },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0]).toEqual({
        toolUseId: 'call_1',
        content: 'AAPL: 50000',
        isError: false,
      });
    });

    it('미등록 도구는 isError: true를 반환한다', async () => {
      const results = await dispatcher.executeAll([
        { id: 'call_2', name: 'unknown_tool', input: {} },
      ]);

      expect(results[0]).toEqual({
        toolUseId: 'call_2',
        content: 'Unknown tool: unknown_tool',
        isError: true,
      });
    });

    it('실행 에러 시 isError: true로 에러 메시지를 반환한다', async () => {
      dispatcher.register('failing_tool', {
        execute: async () => {
          throw new Error('API unavailable');
        },
      });

      const results = await dispatcher.executeAll([
        { id: 'call_3', name: 'failing_tool', input: {} },
      ]);

      expect(results[0]).toEqual({
        toolUseId: 'call_3',
        content: 'Tool execution error: API unavailable',
        isError: true,
      });
    });
  });

  describe('결과 크기 제한', () => {
    it('10,000자 초과 결과를 절삭한다', async () => {
      const longResult = 'x'.repeat(15_000);
      dispatcher.register('verbose_tool', {
        execute: async () => longResult,
      });

      const results = await dispatcher.executeAll([
        { id: 'call_4', name: 'verbose_tool', input: {} },
      ]);

      const r = results[0];
      expect(r?.content.length).toBeLessThanOrEqual(10_000 + 20); // + '\n... [truncated]'
      expect(r?.content).toContain('... [truncated]');
      expect(r?.isError).toBe(false);
    });

    it('정확히 10,000자는 절삭하지 않는다', async () => {
      const exactResult = 'y'.repeat(10_000);
      dispatcher.register('exact_tool', {
        execute: async () => exactResult,
      });

      const results = await dispatcher.executeAll([
        { id: 'call_5', name: 'exact_tool', input: {} },
      ]);

      expect(results[0]?.content).toBe(exactResult);
    });
  });

  describe('병렬 실행', () => {
    it('여러 도구를 병렬로 실행한다', async () => {
      const order: string[] = [];

      dispatcher.register('slow', {
        execute: async () => {
          await new Promise((r) => setTimeout(r, 50));
          order.push('slow');
          return 'slow done';
        },
      });
      dispatcher.register('fast', {
        execute: async () => {
          order.push('fast');
          return 'fast done';
        },
      });

      const calls: ToolCall[] = [
        { id: 'c1', name: 'slow', input: {} },
        { id: 'c2', name: 'fast', input: {} },
      ];

      const results = await dispatcher.executeAll(calls);
      expect(results).toHaveLength(2);
      // fast가 먼저 완료되어야 병렬 실행이 증명됨
      expect(order[0]).toBe('fast');
      expect(results[0]?.content).toBe('slow done');
      expect(results[1]?.content).toBe('fast done');
    });
  });

  describe('AbortSignal', () => {
    it('signal을 핸들러에 전달한다', async () => {
      const receivedSignal = vi.fn();
      dispatcher.register('sig_tool', {
        execute: async (_input, signal) => {
          receivedSignal(signal);
          return 'ok';
        },
      });

      const controller = new AbortController();
      await dispatcher.executeAll([{ id: 'c1', name: 'sig_tool', input: {} }], controller.signal);

      expect(receivedSignal).toHaveBeenCalledWith(controller.signal);
    });
  });
});
