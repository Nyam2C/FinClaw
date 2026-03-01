// packages/server/src/gateway/registry.ts
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { ActiveSession, RegistryEvent } from './rpc/types.js';

/**
 * Chat 실행 레지스트리
 *
 * - 세션 시작/종료/조회
 * - 동일 연결에서 중복 실행 방지
 * - TTL 기반 자동 만료 (AbortSignal.timeout)
 * - 주기적 cleanup (60초 간격)
 * - 이벤트 발행 (session_started, session_completed, session_error)
 */
export class ChatRegistry {
  private readonly sessions = new Map<string, ActiveSession>();
  private readonly emitter = new EventEmitter();
  private readonly cleanupTimer: ReturnType<typeof setInterval>;

  constructor(private readonly sessionTtlMs: number) {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
  }

  /** 새 세션 시작 */
  startSession(params: { agentId: string; connectionId: string; model?: string }): ActiveSession {
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
    };

    // TTL 기반 자동 타임아웃
    // TODO(review-3): stopSession 시 TTL 타이머가 남아있음. AbortSignal.any 패턴으로 정리 권장
    const ttlSignal = AbortSignal.timeout(this.sessionTtlMs);
    ttlSignal.addEventListener('abort', () => {
      if (this.sessions.has(session.sessionId)) {
        this.stopSession(session.sessionId);
      }
    });

    this.sessions.set(session.sessionId, session);
    this.emit({ type: 'session_started', session });

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

    this.emit({
      type: 'session_completed',
      sessionId,
      durationMs: Date.now() - session.startedAt,
    });

    return { stopped: true };
  }

  /** 세션 조회 */
  getSession(sessionId: string): ActiveSession | undefined {
    return this.sessions.get(sessionId);
  }

  /** 모든 세션 목록 */
  listSessions(): ActiveSession[] {
    return [...this.sessions.values()];
  }

  /** 모든 세션 abort (shutdown 용) */
  abortAll(): void {
    for (const session of this.sessions.values()) {
      session.abortController.abort();
    }
    this.sessions.clear();
  }

  /** 활성 세션 수 */
  activeCount(): number {
    return this.sessions.size;
  }

  /** TTL 만료 세션 정리 */
  private cleanup(): void {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.startedAt > this.sessionTtlMs) {
        this.stopSession(id);
      }
    }
  }

  /** 리소스 해제 */
  dispose(): void {
    clearInterval(this.cleanupTimer);
    this.abortAll();
  }

  /** 이벤트 리스너 등록. 해제 함수 반환. */
  on(listener: (event: RegistryEvent) => void): () => void {
    this.emitter.on('event', listener);
    return () => this.emitter.off('event', listener);
  }

  private emit(event: RegistryEvent): void {
    this.emitter.emit('event', event);
  }
}
