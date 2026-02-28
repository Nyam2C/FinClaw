// packages/server/src/auto-reply/stages/normalize.ts
import type { MsgContext } from '@finclaw/types';
import type { StageResult } from '../pipeline.js';

/**
 * 정규화 결과 필드
 *
 * 봇 필터링, 빈 메시지 필터링, 메시지 dedupe는 MessageRouter가 이미 처리한다.
 * Normalize 스테이지는 멘션/URL 추출과 normalizedBody 생성만 담당한다.
 */
export interface NormalizedMessage {
  readonly ctx: MsgContext;
  readonly normalizedBody: string;
  readonly mentions: readonly string[];
  readonly urls: readonly string[];
}

/**
 * 메시지 정규화
 *
 * 1. 콘텐츠 트림 + 연속 공백 정규화
 * 2. 멘션 태그 추출 (<@userId> 패턴)
 * 3. URL 추출
 */
export function normalizeMessage(ctx: MsgContext): StageResult<NormalizedMessage> {
  const body = ctx.body.trim();

  // 멘션 추출
  const mentionPattern = /<@!?(\d+)>/g;
  const mentions: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = mentionPattern.exec(body)) !== null) {
    mentions.push(match[1]);
  }

  // URL 추출
  const urlPattern = /https?:\/\/[^\s<>]+/g;
  const urls = body.match(urlPattern) ?? [];

  return {
    action: 'continue',
    data: {
      ctx,
      normalizedBody: body.replace(/\s+/g, ' '),
      mentions,
      urls,
    },
  };
}
