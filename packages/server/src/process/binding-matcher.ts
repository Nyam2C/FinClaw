// packages/server/src/process/binding-matcher.ts
import type { FinClawConfig } from '@finclaw/types';
import type { InboundMessage, AgentId, ChannelId } from '@finclaw/types';

/**
 * 4계층 매칭 우선순위 (OpenClaw 8계층에서 축소)
 *
 * 1. peer    — senderId 지정 (특정 사용자 → 특정 에이전트)
 * 2. channel — channelId 지정 (특정 채널 → 특정 에이전트)
 * 3. account — accountId 지정 (계정 단위)
 * 4. default — 글로벌 기본 에이전트
 */
export type MatchTier = 'peer' | 'channel' | 'account' | 'default';

export interface BindingRule {
  agentId: AgentId;
  channelId?: ChannelId;
  /** 특정 발신자 바인딩 */
  senderId?: string;
  /** 계정 단위 바인딩 */
  accountId?: string;
  chatType?: 'direct' | 'group' | 'channel';
  priority: number; // 높을수록 우선
}

export interface BindingMatch {
  agentId: AgentId;
  rule: BindingRule;
  matchTier: MatchTier;
}

/**
 * 인바운드 메시지에 대한 에이전트 바인딩 매칭 (4계층)
 *
 * 우선순위: peer > channel > account > default
 */
export function matchBinding(
  msg: InboundMessage,
  rules: BindingRule[],
  defaultAgentId: AgentId,
): BindingMatch {
  const sorted = [...rules].toSorted((a, b) => b.priority - a.priority);

  for (const rule of sorted) {
    // chatType 필터 (있으면 적용)
    if (rule.chatType && rule.chatType !== msg.chatType) {
      continue;
    }

    // 1. peer 바인딩 (senderId 일치)
    if (rule.senderId) {
      if (rule.senderId === msg.senderId) {
        return { agentId: rule.agentId, rule, matchTier: 'peer' };
      }
      continue;
    }

    // 2. channel 바인딩 (channelId 일치)
    if (rule.channelId) {
      if (rule.channelId === msg.channelId) {
        return { agentId: rule.agentId, rule, matchTier: 'channel' };
      }
      continue;
    }

    // 3. account 바인딩 (accountId ↔ senderId)
    if (rule.accountId) {
      if (rule.accountId === msg.senderId) {
        return { agentId: rule.agentId, rule, matchTier: 'account' };
      }
      continue;
    }
  }

  // 4. default
  return {
    agentId: defaultAgentId,
    rule: { agentId: defaultAgentId, priority: 0 },
    matchTier: 'default',
  };
}

/**
 * 설정에서 바인딩 규칙 추출
 */
export function extractBindingRules(config: FinClawConfig): BindingRule[] {
  const rules: BindingRule[] = [];

  const entries = config.agents?.entries ?? {};
  for (const [agentId, entry] of Object.entries(entries)) {
    if (entry.agentDir) {
      rules.push({
        agentId: agentId as AgentId,
        priority: 10,
      });
    }
  }

  return rules;
}
