import type { ChannelId, AsyncDisposable } from './common.js';
import type { InboundMessage, OutboundMessage } from './message.js';

/** 채널 플러그인 -- OpenClaw ChannelPlugin<ResolvedAccount> 대응 */
export interface ChannelPlugin<TAccount = unknown> {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;

  setup?(config: TAccount): Promise<AsyncDisposable>;
  onMessage?(handler: (msg: InboundMessage) => Promise<void>): AsyncDisposable;
  send?(msg: OutboundMessage): Promise<void>;
  sendTyping?(channelId: string, chatId: string): Promise<void>;
  addReaction?(messageId: string, emoji: string): Promise<void>;
}

/** 채널 메타데이터 */
export interface ChannelMeta {
  name: string;
  displayName: string;
  icon?: string;
  color?: string;
  website?: string;
}

/** 채널 기능 */
export interface ChannelCapabilities {
  supportsMarkdown: boolean;
  supportsImages: boolean;
  supportsAudio: boolean;
  supportsVideo: boolean;
  supportsButtons: boolean;
  supportsThreads: boolean;
  supportsReactions: boolean;
  supportsEditing: boolean;
  maxMessageLength: number;
  maxMediaSize?: number;
}

/** 경량 채널 Dock */
export interface ChannelDock {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  defaultChatType: 'direct' | 'group';
  threadingMode: 'none' | 'native' | 'emulated';
  outboundLimits: OutboundLimits;
}

/** 아웃바운드 제한 */
export interface OutboundLimits {
  maxChunkLength: number;
  maxMediaPerMessage: number;
  rateLimitPerMinute: number;
}
