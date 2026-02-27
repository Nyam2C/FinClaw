// packages/server/src/channels/chat-type.ts
import type { ChatType } from '@finclaw/types';

/** 다양한 채널별 chat type 문자열을 정규화된 ChatType으로 변환 */
export function normalizeChatType(raw: string): ChatType {
  const lower = raw.toLowerCase().trim();

  // direct 유형
  if (lower === 'direct' || lower === 'dm' || lower === 'private' || lower === 'whisper') {
    return 'direct';
  }

  // group 유형
  if (lower === 'group' || lower === 'room' || lower === 'chat') {
    return 'group';
  }

  // channel 유형
  if (lower === 'channel' || lower === 'public' || lower === 'forum') {
    return 'channel';
  }

  // 기본값
  return 'group';
}

/** DM 여부 판별 */
export function isDirect(chatType: ChatType): boolean {
  return chatType === 'direct';
}

/** 다자간 대화 여부 판별 (group 또는 channel) */
export function isMultiUser(chatType: ChatType): boolean {
  return chatType === 'group' || chatType === 'channel';
}
