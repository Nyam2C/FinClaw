// packages/server/src/gateway/registry.test.ts
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { ChatRegistry } from './registry.js';

describe('ChatRegistry', () => {
  let registry: ChatRegistry;

  beforeEach(() => {
    registry = new ChatRegistry(60_000);
  });

  afterEach(() => {
    registry.dispose();
  });

  describe('startSession', () => {
    it('creates a new session with running status', () => {
      const session = registry.startSession({
        agentId: 'agent-1',
        connectionId: 'conn-1',
      });
      expect(session.sessionId).toBeDefined();
      expect(session.agentId).toBe('agent-1');
      expect(session.connectionId).toBe('conn-1');
      expect(session.status).toBe('running');
      expect(session.abortController).toBeInstanceOf(AbortController);
    });

    it('increments active count', () => {
      expect(registry.activeCount()).toBe(0);
      registry.startSession({ agentId: 'a', connectionId: 'c1' });
      expect(registry.activeCount()).toBe(1);
      registry.startSession({ agentId: 'a', connectionId: 'c2' });
      expect(registry.activeCount()).toBe(2);
    });

    it('throws when same connection already has running session', () => {
      registry.startSession({ agentId: 'a', connectionId: 'c1' });
      expect(() => registry.startSession({ agentId: 'b', connectionId: 'c1' })).toThrow(
        'Session already active',
      );
    });

    it('allows same connection after previous session stopped', () => {
      const s1 = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      registry.stopSession(s1.sessionId);
      const s2 = registry.startSession({ agentId: 'b', connectionId: 'c1' });
      expect(s2.sessionId).toBeDefined();
    });

    it('emits session_started event', () => {
      const listener = vi.fn();
      registry.on(listener);
      const session = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'session_started',
          session: expect.objectContaining({ sessionId: session.sessionId }),
        }),
      );
    });
  });

  describe('stopSession', () => {
    it('stops and removes existing session', () => {
      const session = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      const result = registry.stopSession(session.sessionId);
      expect(result.stopped).toBe(true);
      expect(registry.activeCount()).toBe(0);
    });

    it('returns { stopped: false } for unknown session', () => {
      const result = registry.stopSession('nonexistent');
      expect(result.stopped).toBe(false);
    });

    it('aborts the session AbortController', () => {
      const session = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      registry.stopSession(session.sessionId);
      expect(session.abortController.signal.aborted).toBe(true);
    });

    it('emits session_completed event with duration', () => {
      const listener = vi.fn();
      registry.on(listener);
      const session = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      registry.stopSession(session.sessionId);

      const completedEvent = listener.mock.calls.find(
        (call: unknown[]) => (call[0] as { type: string }).type === 'session_completed',
      );
      expect(completedEvent).toBeDefined();
      expect(completedEvent?.[0].durationMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getSession / listSessions', () => {
    it('getSession returns session by id', () => {
      const session = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      expect(registry.getSession(session.sessionId)).toBe(session);
    });

    it('getSession returns undefined for unknown id', () => {
      expect(registry.getSession('unknown')).toBeUndefined();
    });

    it('listSessions returns all active sessions', () => {
      registry.startSession({ agentId: 'a', connectionId: 'c1' });
      registry.startSession({ agentId: 'b', connectionId: 'c2' });
      expect(registry.listSessions()).toHaveLength(2);
    });
  });

  describe('abortAll', () => {
    it('aborts all sessions and clears the map', () => {
      const s1 = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      const s2 = registry.startSession({ agentId: 'b', connectionId: 'c2' });
      registry.abortAll();
      expect(s1.abortController.signal.aborted).toBe(true);
      expect(s2.abortController.signal.aborted).toBe(true);
      expect(registry.activeCount()).toBe(0);
    });
  });

  describe('TTL expiry', () => {
    it('auto-stops session after TTL via cleanup', () => {
      vi.useFakeTimers();
      const shortRegistry = new ChatRegistry(1_000);
      const session = shortRegistry.startSession({ agentId: 'a', connectionId: 'c1' });

      // 60초 후 cleanup 실행
      vi.advanceTimersByTime(61_000);

      expect(shortRegistry.getSession(session.sessionId)).toBeUndefined();
      expect(shortRegistry.activeCount()).toBe(0);
      shortRegistry.dispose();
      vi.useRealTimers();
    });
  });

  describe('dispose', () => {
    it('clears cleanup timer and aborts all', () => {
      const session = registry.startSession({ agentId: 'a', connectionId: 'c1' });
      registry.dispose();
      expect(session.abortController.signal.aborted).toBe(true);
      expect(registry.activeCount()).toBe(0);
    });
  });
});
