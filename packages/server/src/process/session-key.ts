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

function normalizeChannelId(id: string): string {
  return id.toLowerCase().trim();
}

function normalizeChatId(id: string): string {
  return id.replace(/@[a-zA-Z0-9.]+$/, '').trim();
}
