// packages/tui/src/__tests__/chat.test.ts

import type {
  ChatStreamDeltaParams,
  ChatStreamErrorParams,
  ChatStreamToolStartParams,
  ChatStreamToolEndParams,
} from '@finclaw/types';
import { describe, it, expect } from 'vitest';

/**
 * TUI 채팅 핸들러 단위 테스트
 *
 * App.tsx의 notification 라우팅 로직을 함수 단위로 추출하여 테스트.
 * Ink 컴포넌트 렌더링이 아닌 순수 로직 검증.
 */

// ─── notification 라우팅 로직 추출 ───

interface ChatState {
  messages: Array<{ role: string; content: string }>;
  streamText: string;
}

function handleNotification(
  state: ChatState,
  method: string,
  params: Record<string, unknown>,
): ChatState {
  switch (method) {
    case 'chat.stream.delta': {
      const { delta } = params as unknown as ChatStreamDeltaParams;
      return { ...state, streamText: state.streamText + delta };
    }
    case 'chat.stream.end': {
      return {
        messages: [...state.messages, { role: 'assistant', content: state.streamText }],
        streamText: '',
      };
    }
    case 'chat.stream.error': {
      const { error } = params as unknown as ChatStreamErrorParams;
      return {
        messages: [...state.messages, { role: 'system', content: `[Error] ${error}` }],
        streamText: '',
      };
    }
    case 'chat.stream.tool_start': {
      const { toolCall } = params as unknown as ChatStreamToolStartParams;
      return {
        ...state,
        messages: [...state.messages, { role: 'system', content: `[Tool] ${toolCall.name}` }],
      };
    }
    case 'chat.stream.tool_end': {
      const { result } = params as unknown as ChatStreamToolEndParams;
      return {
        ...state,
        messages: [...state.messages, { role: 'tool', content: JSON.stringify(result) }],
      };
    }
    default:
      return state;
  }
}

function handleCommand(command: string): { action: string; args?: string } {
  const cmd = command.slice(1).toLowerCase();
  switch (cmd) {
    case 'help':
      return { action: 'help' };
    case 'market':
    case 'portfolio':
    case 'alerts':
    case 'settings':
      return { action: 'navigate', args: cmd };
    case 'quit':
      return { action: 'quit' };
    default:
      return { action: 'unknown', args: command };
  }
}

// ─── 테스트 ───

describe('chat notification routing', () => {
  it('chat.stream.delta — 증분 텍스트 누적', () => {
    let state: ChatState = { messages: [], streamText: '' };

    state = handleNotification(state, 'chat.stream.delta', {
      sessionId: 'sess-1',
      delta: 'Hello',
    });
    expect(state.streamText).toBe('Hello');

    state = handleNotification(state, 'chat.stream.delta', {
      sessionId: 'sess-1',
      delta: ' World',
    });
    expect(state.streamText).toBe('Hello World');
  });

  it('chat.stream.end — 스트리밍 완료, 메시지 확정', () => {
    let state: ChatState = { messages: [], streamText: 'Hello World' };

    state = handleNotification(state, 'chat.stream.end', {
      sessionId: 'sess-1',
      result: {},
    });

    expect(state.streamText).toBe('');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual({
      role: 'assistant',
      content: 'Hello World',
    });
  });

  it('chat.stream.error — 에러 메시지 추가, 스트림 초기화', () => {
    let state: ChatState = { messages: [], streamText: 'partial' };

    state = handleNotification(state, 'chat.stream.error', {
      sessionId: 'sess-1',
      error: 'Model overloaded',
    });

    expect(state.streamText).toBe('');
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual({
      role: 'system',
      content: '[Error] Model overloaded',
    });
  });

  it('chat.stream.tool_start — 도구 호출 표시', () => {
    let state: ChatState = { messages: [], streamText: '' };

    state = handleNotification(state, 'chat.stream.tool_start', {
      sessionId: 'sess-1',
      toolCall: { name: 'finance.quote', input: { symbol: 'AAPL' } },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual({
      role: 'system',
      content: '[Tool] finance.quote',
    });
  });

  it('chat.stream.tool_end — 도구 결과 표시', () => {
    let state: ChatState = { messages: [], streamText: '' };

    state = handleNotification(state, 'chat.stream.tool_end', {
      sessionId: 'sess-1',
      result: { price: 150.0 },
    });

    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]).toEqual({
      role: 'tool',
      content: '{"price":150}',
    });
  });

  it('전체 스트리밍 흐름: delta 누적 → tool → delta → end', () => {
    let state: ChatState = { messages: [], streamText: '' };

    state = handleNotification(state, 'chat.stream.delta', {
      sessionId: 's1',
      delta: 'AAPL 시세를 확인',
    });
    state = handleNotification(state, 'chat.stream.tool_start', {
      sessionId: 's1',
      toolCall: { name: 'finance.quote', input: { symbol: 'AAPL' } },
    });
    state = handleNotification(state, 'chat.stream.tool_end', {
      sessionId: 's1',
      result: { price: 150.0 },
    });
    state = handleNotification(state, 'chat.stream.delta', {
      sessionId: 's1',
      delta: '합니다. $150입니다.',
    });
    state = handleNotification(state, 'chat.stream.end', {
      sessionId: 's1',
      result: {},
    });

    expect(state.streamText).toBe('');
    expect(state.messages).toHaveLength(3); // tool_start + tool_end + assistant
    expect(state.messages[1]?.role).toBe('tool');
    expect(state.messages[2]?.role).toBe('assistant');
    expect(state.messages[2]?.content).toContain('$150');
  });

  it('미지원 method는 상태를 변경하지 않는다', () => {
    const state: ChatState = { messages: [], streamText: '' };
    const result = handleNotification(state, 'unknown.method', {});
    expect(result).toEqual(state);
  });
});

describe('slash commands', () => {
  it('/help → help action', () => {
    expect(handleCommand('/help')).toEqual({ action: 'help' });
  });

  it('/market → navigate to market', () => {
    expect(handleCommand('/market')).toEqual({
      action: 'navigate',
      args: 'market',
    });
  });

  it('/portfolio → navigate to portfolio', () => {
    expect(handleCommand('/portfolio')).toEqual({
      action: 'navigate',
      args: 'portfolio',
    });
  });

  it('/quit → quit action', () => {
    expect(handleCommand('/quit')).toEqual({ action: 'quit' });
  });

  it('unknown command → unknown action', () => {
    expect(handleCommand('/xyz')).toEqual({
      action: 'unknown',
      args: '/xyz',
    });
  });
});
