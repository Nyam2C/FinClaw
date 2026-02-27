// packages/server/src/channels/dock.ts
import type { ChannelDock, ChannelCapabilities, ChannelMeta, OutboundLimits } from '@finclaw/types';
import { createChannelId } from '@finclaw/types';

export interface CreateDockOptions {
  id: string;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  defaultChatType?: 'direct' | 'group';
  threadingMode?: 'none' | 'native' | 'emulated';
  outboundLimits?: Partial<OutboundLimits>;
}

const DEFAULT_LIMITS: OutboundLimits = {
  maxChunkLength: 2000,
  maxMediaPerMessage: 1,
  rateLimitPerMinute: 30,
};

/** ChannelDock 팩토리 — 기본값 병합 */
export function createChannelDock(opts: CreateDockOptions): ChannelDock {
  return {
    id: createChannelId(opts.id),
    meta: opts.meta,
    capabilities: opts.capabilities,
    defaultChatType: opts.defaultChatType ?? 'group',
    threadingMode: opts.threadingMode ?? 'none',
    outboundLimits: { ...DEFAULT_LIMITS, ...opts.outboundLimits },
  };
}

/** 코어 도크: Discord */
const DISCORD_DOCK = createChannelDock({
  id: 'discord',
  meta: {
    name: 'discord',
    displayName: 'Discord',
    icon: 'discord',
    color: '#5865F2',
    website: 'https://discord.com',
  },
  capabilities: {
    supportsMarkdown: true,
    supportsImages: true,
    supportsAudio: false,
    supportsVideo: false,
    supportsButtons: true,
    supportsThreads: true,
    supportsReactions: true,
    supportsEditing: true,
    maxMessageLength: 2000,
  },
  defaultChatType: 'group',
  threadingMode: 'native',
  outboundLimits: {
    maxChunkLength: 2000,
    maxMediaPerMessage: 10,
    rateLimitPerMinute: 50,
  },
});

/** 코어 도크: HTTP Webhook */
const HTTP_WEBHOOK_DOCK = createChannelDock({
  id: 'http-webhook',
  meta: {
    name: 'http-webhook',
    displayName: 'HTTP Webhook',
    icon: 'webhook',
  },
  capabilities: {
    supportsMarkdown: false,
    supportsImages: false,
    supportsAudio: false,
    supportsVideo: false,
    supportsButtons: false,
    supportsThreads: false,
    supportsReactions: false,
    supportsEditing: false,
    maxMessageLength: 65536,
  },
  defaultChatType: 'direct',
  threadingMode: 'none',
  outboundLimits: {
    maxChunkLength: 65536,
    maxMediaPerMessage: 0,
    rateLimitPerMinute: 120,
  },
});

/** 내장 코어 도크 목록 */
export const CORE_DOCKS: readonly ChannelDock[] = Object.freeze([DISCORD_DOCK, HTTP_WEBHOOK_DOCK]);
