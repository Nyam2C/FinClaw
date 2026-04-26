// packages/web/src/__tests__/app-chat.test.ts

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createAppChat, type AppChat, type ChatState } from '../app-chat.js';
import type { AppGateway, NotificationHandler } from '../app-gateway.js';

function createMockGateway(): AppGateway & {
  fireNotification: (method: string, params: Record<string, unknown>) => void;
} {
  const notificationHandlers = new Set<NotificationHandler>();

  return {
    isConnected: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
    send: vi.fn().mockResolvedValue(undefined),
    onNotification(handler: NotificationHandler) {
      notificationHandlers.add(handler);
    },
    offNotification(handler: NotificationHandler) {
      notificationHandlers.delete(handler);
    },
    onConnected: vi.fn(),
    onDisconnected: vi.fn(),
    fireNotification(method: string, params: Record<string, unknown>) {
      for (const h of notificationHandlers) {
        h(method, params);
      }
    },
  };
}

const SESSION = 'test-session-1';

describe('createAppChat', () => {
  let gateway: ReturnType<typeof createMockGateway>;
  let chat: AppChat;

  beforeEach(() => {
    gateway = createMockGateway();
    chat = createAppChat(gateway, SESSION);
  });

  it('should start with idle status and empty messages', () => {
    const state = chat.getState();
    expect(state.status).toBe('idle');
    expect(state.messages).toEqual([]);
    expect(state.streamBuffer).toBe('');
  });

  it('should add user message and call gateway.send', async () => {
    await chat.sendMessage('hello');
    const state = chat.getState();
    expect(state.messages).toHaveLength(1);
    expect(state.messages[0]?.role).toBe('user');
    expect(state.messages[0]?.content).toBe('hello');
    expect(gateway.send).toHaveBeenCalledWith('chat.send', {
      sessionId: SESSION,
      message: 'hello',
    });
  });

  it('should accumulate stream deltas', async () => {
    await chat.sendMessage('hi');

    gateway.fireNotification('chat.stream.delta', { sessionId: SESSION, delta: 'Hello' });
    expect(chat.getState().streamBuffer).toBe('Hello');

    gateway.fireNotification('chat.stream.delta', { sessionId: SESSION, delta: ' world' });
    expect(chat.getState().streamBuffer).toBe('Hello world');
  });

  it('should finalize assistant message on stream end', async () => {
    await chat.sendMessage('hi');

    gateway.fireNotification('chat.stream.delta', { sessionId: SESSION, delta: 'Response' });
    gateway.fireNotification('chat.stream.end', { sessionId: SESSION, result: null });

    const state = chat.getState();
    expect(state.messages).toHaveLength(2); // user + assistant
    expect(state.messages[1]?.role).toBe('assistant');
    expect(state.messages[1]?.content).toBe('Response');
    expect(state.streamBuffer).toBe('');
    expect(state.status).toBe('idle');
  });

  it('should set error on stream error', async () => {
    await chat.sendMessage('hi');

    gateway.fireNotification('chat.stream.error', {
      sessionId: SESSION,
      error: 'Something broke',
    });

    const state = chat.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('Something broke');
  });

  it('should track tool start and end', async () => {
    await chat.sendMessage('search');

    gateway.fireNotification('chat.stream.tool_start', {
      sessionId: SESSION,
      toolCall: { name: 'web_search', input: { query: 'AAPL' } },
    });

    expect(chat.getState().tools).toHaveLength(1);
    expect(chat.getState().tools[0]?.name).toBe('web_search');

    gateway.fireNotification('chat.stream.tool_end', {
      sessionId: SESSION,
      result: { data: 'results' },
    });

    expect(chat.getState().tools[0]?.result).toEqual({ data: 'results' });
  });

  it('should ignore notifications for different sessions', async () => {
    await chat.sendMessage('hi');

    gateway.fireNotification('chat.stream.delta', {
      sessionId: 'other-session',
      delta: 'should ignore',
    });

    expect(chat.getState().streamBuffer).toBe('');
  });

  it('should notify state change listeners', async () => {
    const listener = vi.fn();
    chat.onStateChange(listener);

    await chat.sendMessage('test');
    // At least 2 calls: one for adding user message, one for status change
    expect(listener).toHaveBeenCalled();
    const lastCall = listener.mock.calls[listener.mock.calls.length - 1] as [ChatState];
    expect(lastCall[0].messages).toHaveLength(1);
  });

  it('should remove state change listener with offStateChange', async () => {
    const listener = vi.fn();
    chat.onStateChange(listener);
    chat.offStateChange(listener);

    await chat.sendMessage('test');
    expect(listener).not.toHaveBeenCalled();
  });

  it('should flush queue and reset stream state', async () => {
    await chat.sendMessage('hello');
    gateway.fireNotification('chat.stream.delta', { sessionId: SESSION, delta: 'partial' });

    chat.flush();

    const state = chat.getState();
    expect(state.streamBuffer).toBe('');
    expect(state.status).toBe('idle');
    expect(state.error).toBeNull();
  });

  it('should unregister notification handler on dispose', async () => {
    chat.dispose();

    // Fire a notification — should not affect disposed chat
    gateway.fireNotification('chat.stream.delta', { sessionId: SESSION, delta: 'should ignore' });
    expect(chat.getState().streamBuffer).toBe('');
  });

  it('should queue messages and process sequentially', async () => {
    // Send two messages without waiting for stream end
    const p1 = chat.sendMessage('first');
    const p2 = chat.sendMessage('second');
    await p1;
    await p2;

    // First message should have been sent
    expect(gateway.send).toHaveBeenCalledTimes(1);
    expect(gateway.send).toHaveBeenCalledWith('chat.send', {
      sessionId: SESSION,
      message: 'first',
    });

    // Complete first stream
    gateway.fireNotification('chat.stream.end', { sessionId: SESSION, result: null });

    // Now second message should be processed
    // Need microtask to flush
    await new Promise((r) => setTimeout(r, 0));

    expect(gateway.send).toHaveBeenCalledTimes(2);
  });

  it('should handle send error gracefully', async () => {
    (gateway.send as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error('Network error'));

    await chat.sendMessage('will fail');

    const state = chat.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('Network error');
  });
});
