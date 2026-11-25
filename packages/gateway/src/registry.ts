// packages/server/src/gateway/registry.ts
import { randomUUID } from 'node:crypto';
import type { ModelRef, SessionKey } from '@finclaw/types';
import type { ActiveSession } from './rpc/types.js';

/**
 * Chat 실행 레지스트리
 *
 * - 세션 시작/종료/조회
 * - 동일 연결에서 중복 실행 방지
 * - 마지막 활동(chat.send 수신·run 종료) 기준 유휴 TTL 만료 — 진행 중 run 이 있으면 유지
 * - 주기적 cleanup (60초 간격)
 */
export class ChatRegistry {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly activity = new Map<string, { lastActiveAt: number; runs: number }>();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly sessionTtlMs: number) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  /** 새 세션 시작 */
  startSession(params: {
    agentId: string;
    connectionId: string;
    model: ModelRef;
    sessionKey: SessionKey;
  }): ActiveSession {
    // 동일 연결에서 이미 running 세션이 있으면 거부
    for (const session of this.sessions.values()) {
      if (session.connectionId === params.connectionId && session.status === 'running') {
        throw new Error('Session already active on this connection');
      }
    }

    const session: ActiveSession = {
      sessionId: randomUUID(),
      agentId: params.agentId,
      connectionId: params.connectionId,
      startedAt: Date.now(),
      status: 'running',
      abortController: new AbortController(),
      model: params.model,
      sessionKey: params.sessionKey,
    };

    this.sessions.set(session.sessionId, session);
    this.activity.set(session.sessionId, { lastActiveAt: session.startedAt, runs: 0 });

    return session;
  }

  /** 세션 중단 */
  stopSession(sessionId: string): { stopped: boolean } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { stopped: false };
    }

    session.abortController.abort();
    this.sessions.delete(sessionId);
    this.activity.delete(sessionId);

    return { stopped: true };
  }

  /** chat.send 수신 — 유휴 TTL 연장 + 진행 중 run 표시 (진행 중이면 만료하지 않는다) */
  runStarted(sessionId: string): void {
    const a = this.activity.get(sessionId);
    if (a) {
      a.runs++;
      a.lastActiveAt = Date.now();
    }
  }

  /** run 종료 — 유휴 TTL 은 이 시점부터 다시 센다 */
  runEnded(sessionId: string): void {
    const a = this.activity.get(sessionId);
    if (a) {
      a.runs--;
      a.lastActiveAt = Date.now();
    }
  }

  /** 세션 조회 */
  getSession(sessionId: string): ActiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** 모든 세션 abort (shutdown 용) */
  abortAll(): void {
    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }
    this.sessions.clear();
    this.activity.clear();
  }

  /** 활성 세션 수 */
  activeCount(): number {
    return this.sessions.size;
  }

  /** 유휴 TTL 만료 세션 정리 */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, a] of this.activity) {
      if (a.runs === 0 && now - a.lastActiveAt > this.sessionTtlMs) {
        this.stopSession(id);
      }
    }
  }

  /** 리소스 해제 */
  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.abortAll();
  }
}
