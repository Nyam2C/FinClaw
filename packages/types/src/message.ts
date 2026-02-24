import type { ChannelId, SessionKey, Timestamp } from './common.js';

/** 정규화된 채팅 유형 */
export type ChatType = 'direct' | 'group' | 'channel';

/** 인바운드 메시지 -- 채널에서 수신한 원시 메시지 */
export interface InboundMessage {
  id: string;
  channelId: ChannelId;
  chatType: ChatType;
  senderId: string;
  senderName?: string;
  body: string;
  rawBody?: string;
  timestamp: Timestamp;
  threadId?: string;
  replyToId?: string;
  media?: MediaAttachment[];
  metadata?: Record<string, unknown>;
}

/** 미디어 첨부 */
export interface MediaAttachment {
  type: 'image' | 'audio' | 'video' | 'document';
  url?: string;
  path?: string;
  mimeType?: string;
  size?: number;
  filename?: string;
}

/** 메시지 컨텍스트 -- OpenClaw MsgContext(60+ 필드)의 축소판 */
export interface MsgContext {
  body: string;
  bodyForAgent: string;
  rawBody: string;
  commandBody?: string;

  from: string;
  senderId: string;
  senderName: string;
  senderUsername?: string;

  provider: string;
  channelId: ChannelId;
  chatType: ChatType;

  sessionKey: SessionKey;
  parentSessionKey?: SessionKey;
  accountId: string;

  groupSubject?: string;
  groupMembers?: number;

  messageThreadId?: string;
  isForum?: boolean;

  media?: MediaAttachment[];

  timestamp: Timestamp;
  isHeartbeat?: boolean;
  isCommand?: boolean;
  commandAuthorized?: boolean;
}

/** 응답 페이로드 */
export interface ReplyPayload {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
  channelData?: Record<string, unknown>;
}

/** 응답 생성 옵션 */
export interface GetReplyOptions {
  runId: string;
  abortSignal?: AbortSignal;
  onPartialReply?: (text: string) => void;
  onModelSelected?: (model: string, provider: string) => void;
  onToolResult?: (toolName: string, result: unknown) => void;
  blockReplyTimeoutMs?: number;
}

/** 아웃바운드 메시지 */
export interface OutboundMessage {
  channelId: ChannelId;
  targetId: string;
  payloads: ReplyPayload[];
  replyToMessageId?: string;
  threadId?: string;
}
