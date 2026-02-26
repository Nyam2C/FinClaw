// packages/server/src/process/session-key.ts
import type { SessionKey, ChannelId, AgentId } from '@finclaw/types';
import { createSessionKey } from '@finclaw/types';

/**
 * 라우팅용 세션 키 도출 (Agent-Scoped)
 *
 * 키 형식: agent:{agentId}:{channelId}:{chatType}[:chatId[:threadId]]
 *
 * 예시:
 * - DM:     "agent:main:discord:direct"
 * - 그룹:   "agent:main:discord:group:channel456"
 * - 스레드: "agent:main:discord:group:channel456:thread789"
 */
export interface RoutingSessionKeyParams {
  channelId: ChannelId;
  accountId: string;
  chatType: 'direct' | 'group' | 'channel';
  chatId?: string;
  threadId?: string;
  /** 에이전트 ID (기본: 'main') */
  agentId?: AgentId | string;
}

export function deriveRoutingSessionKey(params: RoutingSessionKeyParams): SessionKey {
  const agentId = (params.agentId as string) ?? 'main';
  const parts: string[] = [
    'agent',
    agentId,
    normalizeChannelId(params.channelId as string),
    params.chatType,
  ];

  if (params.chatType !== 'direct' && params.chatId) {
    parts.push(normalizeChatId(params.chatId));
  }

  if (params.threadId) {
    parts.push(params.threadId);
  }

  return createSessionKey(parts.join(':'));
}

/** 글로벌 세션 키 (채널 무관, 에이전트 전체) */
export function deriveGlobalSessionKey(agentId: string): SessionKey {
  return createSessionKey(`agent:${agentId}:global`);
}

/** 세션 키 분류 */
export type SessionKeyKind = 'agent' | 'legacy' | 'malformed';

export function classifySessionKey(key: SessionKey): SessionKeyKind {
  const str = key as string;
  if (str.startsWith('agent:')) {
    const parts = str.split(':');
    return parts.length >= 4 ? 'agent' : 'malformed';
  }
  // config의 deriveSessionKey가 생성한 키 (scope:id 형식)
  if (str.includes(':')) {
    return 'legacy';
  }
  return 'malformed';
}

/**
 * 세션 키에서 구성 요소 추출 (agent-scoped 키 전용)
 */
export function parseRoutingSessionKey(key: SessionKey):
  | {
      agentId: string;
      channelId: string;
      chatType: string;
      chatId?: string;
      threadId?: string;
    }
  | undefined {
  if (classifySessionKey(key) !== 'agent') {
    return undefined;
  }
  const parts = (key as string).split(':');
  // agent:{agentId}:{channelId}:{chatType}[:chatId[:threadId]]
  return {
    agentId: parts[1],
    channelId: parts[2],
    chatType: parts[3],
    chatId: parts[4],
    threadId: parts[5],
  };
}

function normalizeChannelId(id: string): string {
  return id.toLowerCase().trim();
}

function normalizeChatId(id: string): string {
  return id.replace(/@[a-zA-Z0-9.]+$/, '').trim();
}
