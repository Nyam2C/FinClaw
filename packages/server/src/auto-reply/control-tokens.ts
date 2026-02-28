// packages/server/src/auto-reply/control-tokens.ts

/**
 * AI 응답 내 인밴드 제어 토큰
 *
 * AI가 응답에 이 토큰들을 포함시켜 파이프라인에 특수 동작을 요청한다.
 * 제어 토큰은 최종 사용자에게는 노출되지 않는다.
 */
export const CONTROL_TOKENS = {
  /** 생성이 정상적으로 진행 중임을 표시 (long-running 작업) */
  HEARTBEAT_OK: '<<HEARTBEAT_OK>>',

  /** 이 메시지에 응답하지 않겠다는 AI의 명시적 결정 */
  NO_REPLY: '<<NO_REPLY>>',

  /** 응답은 하지만 채널에 메시지를 보내지 않음 (로깅만) */
  SILENT_REPLY: '<<SILENT_REPLY>>',

  /** 사용자에게 추가 입력을 요청 */
  NEED_INPUT: '<<NEED_INPUT>>',

  /** 금융 특화: 면책 조항 자동 첨부 플래그 */
  ATTACH_DISCLAIMER: '<<ATTACH_DISCLAIMER>>',

  /** 금융 특화: 이 응답에 실시간 시세를 첨부 */
  ATTACH_QUOTE: '<<ATTACH_QUOTE>>',
} as const;

export type ControlToken = (typeof CONTROL_TOKENS)[keyof typeof CONTROL_TOKENS];

export interface ControlTokenResult {
  readonly cleanContent: string;
  readonly tokens: readonly ControlToken[];
  readonly hasNoReply: boolean;
  readonly hasSilentReply: boolean;
  readonly hasHeartbeat: boolean;
  readonly needsDisclaimer: boolean;
  readonly needsQuote: boolean;
}

const ALL_TOKENS = Object.values(CONTROL_TOKENS);

/**
 * AI 응답에서 제어 토큰 추출
 *
 * 1. 응답 텍스트에서 모든 <<TOKEN>> 패턴 탐지
 * 2. 알려진 제어 토큰과 매칭
 * 3. 제어 토큰을 응답에서 제거
 * 4. 클린 텍스트 + 추출된 토큰 목록 반환
 */
export function extractControlTokens(response: string): ControlTokenResult {
  const found: ControlToken[] = [];
  let cleaned = response;

  for (const token of ALL_TOKENS) {
    if (cleaned.includes(token)) {
      found.push(token);
      cleaned = cleaned.replaceAll(token, '');
    }
  }

  cleaned = cleaned.replace(/\n{3,}/g, '\n\n').trim();

  return {
    cleanContent: cleaned,
    tokens: found,
    hasNoReply: found.includes(CONTROL_TOKENS.NO_REPLY),
    hasSilentReply: found.includes(CONTROL_TOKENS.SILENT_REPLY),
    hasHeartbeat: found.includes(CONTROL_TOKENS.HEARTBEAT_OK),
    needsDisclaimer: found.includes(CONTROL_TOKENS.ATTACH_DISCLAIMER),
    needsQuote: found.includes(CONTROL_TOKENS.ATTACH_QUOTE),
  };
}
