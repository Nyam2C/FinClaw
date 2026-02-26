// packages/infra/src/agent-events.ts
import { getEventBus } from './events.js';

/**
 * 에이전트 실행 시작 이벤트 발행
 */
export function emitAgentRunStart(agentId: string, sessionKey: string): void {
  getEventBus().emit('agent:run:start', agentId, sessionKey);
}

/**
 * 에이전트 실행 완료 이벤트 발행
 */
export function emitAgentRunEnd(agentId: string, sessionKey: string, durationMs: number): void {
  getEventBus().emit('agent:run:end', agentId, sessionKey, durationMs);
}

/**
 * 에이전트 실행 에러 이벤트 발행
 */
export function emitAgentRunError(agentId: string, sessionKey: string, error: Error): void {
  getEventBus().emit('agent:run:error', agentId, sessionKey, error);
}

/**
 * 에이전트 이벤트 구독 편의 함수
 */
export function onAgentRunStart(handler: (agentId: string, sessionKey: string) => void): void {
  getEventBus().on('agent:run:start', handler);
}

export function onAgentRunEnd(
  handler: (agentId: string, sessionKey: string, durationMs: number) => void,
): void {
  getEventBus().on('agent:run:end', handler);
}

export function onAgentRunError(
  handler: (agentId: string, sessionKey: string, error: Error) => void,
): void {
  getEventBus().on('agent:run:error', handler);
}
