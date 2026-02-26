import type { AgentId } from '@finclaw/types';
import type { InboundMessage } from '@finclaw/types';
import { createChannelId, createTimestamp } from '@finclaw/types';
import { describe, it, expect } from 'vitest';
import {
  matchBinding,
  extractBindingRules,
  type BindingRule,
} from '../../src/process/binding-matcher.js';

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    channelId: createChannelId('discord'),
    chatType: 'direct',
    senderId: 'user1',
    body: 'hello',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

const defaultAgent = 'default' as AgentId;

describe('matchBinding', () => {
  it('peer 바인딩이 최우선', () => {
    const rules: BindingRule[] = [
      { agentId: 'agent-channel' as AgentId, channelId: createChannelId('discord'), priority: 10 },
      { agentId: 'agent-peer' as AgentId, senderId: 'user1', priority: 20 },
    ];
    const match = matchBinding(makeMsg(), rules, defaultAgent);
    expect(match.matchTier).toBe('peer');
    expect(match.agentId).toBe('agent-peer');
  });

  it('channel 바인딩 매칭', () => {
    const rules: BindingRule[] = [
      { agentId: 'agent-ch' as AgentId, channelId: createChannelId('discord'), priority: 10 },
    ];
    const match = matchBinding(makeMsg(), rules, defaultAgent);
    expect(match.matchTier).toBe('channel');
  });

  it('account 바인딩 매칭 (accountId === senderId)', () => {
    const rules: BindingRule[] = [
      { agentId: 'agent-acc' as AgentId, accountId: 'user1', priority: 10 },
    ];
    const match = matchBinding(makeMsg({ senderId: 'user1' }), rules, defaultAgent);
    expect(match.matchTier).toBe('account');
    expect(match.agentId).toBe('agent-acc');
  });

  it('account 바인딩 값 불일치 시 default로 폴백', () => {
    const rules: BindingRule[] = [
      { agentId: 'agent-acc' as AgentId, accountId: 'other-account', priority: 10 },
    ];
    const match = matchBinding(makeMsg({ senderId: 'user1' }), rules, defaultAgent);
    expect(match.matchTier).toBe('default');
  });

  it('매칭 규칙 없으면 default', () => {
    const match = matchBinding(makeMsg(), [], defaultAgent);
    expect(match.matchTier).toBe('default');
    expect(match.agentId).toBe(defaultAgent);
  });

  it('chatType 필터가 적용됨', () => {
    const rules: BindingRule[] = [
      {
        agentId: 'agent-group' as AgentId,
        channelId: createChannelId('discord'),
        chatType: 'group',
        priority: 10,
      },
    ];
    // direct 메시지 → chatType=group 규칙은 건너뜀 → default
    const match = matchBinding(makeMsg({ chatType: 'direct' }), rules, defaultAgent);
    expect(match.matchTier).toBe('default');
  });

  it('priority가 높은 규칙이 우선', () => {
    const rules: BindingRule[] = [
      { agentId: 'low' as AgentId, channelId: createChannelId('discord'), priority: 1 },
      { agentId: 'high' as AgentId, channelId: createChannelId('discord'), priority: 100 },
    ];
    const match = matchBinding(makeMsg(), rules, defaultAgent);
    expect(match.agentId).toBe('high');
  });
});

describe('extractBindingRules', () => {
  it('agentDir가 있는 에이전트만 규칙 생성', () => {
    const rules = extractBindingRules({
      agents: {
        entries: {
          main: { agentDir: './agents/main' },
          empty: {},
        },
      },
    });
    expect(rules).toHaveLength(1);
    expect(rules[0].agentId).toBe('main');
  });

  it('agents가 없으면 빈 배열', () => {
    expect(extractBindingRules({})).toEqual([]);
  });
});
