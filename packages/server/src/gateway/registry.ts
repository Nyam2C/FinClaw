// packages/server/src/gateway/registry.ts
import type { ActiveSession, RegistryEvent } from './rpc/types.js';

/**
 * Chat 실행 레지스트리 (스텁)
 * Part 3에서 TTL, AbortSignal, 중복 방지, cleanup 포함하여 완성.
 */
export class ChatRegistry {
  private readonly sessions = new Map<string, ActiveSession>();

  constructor(private readonly sessionTtlMs: number) {}

  startSession(_params: { agentId: string; connectionId: string; model?: string }): ActiveSession {
    throw new Error('Not implemented — see Part 3');
  }

  stopSession(_sessionId: string): { stopped: boolean } {
    throw new Error('Not implemented — see Part 3');
  }

  getSession(sessionId: string): ActiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  listSessions(): ActiveSession[] {
    return [...this.sessions.values()];
  }

  abortAll(): void {
    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }
    this.sessions.clear();
  }

  activeCount(): number {
    return this.sessions.size;
  }

  dispose(): void {
    this.abortAll();
  }

  on(_listener: (event: RegistryEvent) => void): () => void {
    return () => {};
  }
}
