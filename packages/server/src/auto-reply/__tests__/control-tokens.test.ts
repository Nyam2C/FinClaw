import { describe, it, expect } from 'vitest';
import { CONTROL_TOKENS, extractControlTokens } from '../control-tokens.js';

describe('extractControlTokens', () => {
  it('토큰이 없는 응답에서 빈 결과를 반환한다', () => {
    const result = extractControlTokens('안녕하세요, 도움이 필요하신가요?');

    expect(result.tokens).toHaveLength(0);
    expect(result.cleanContent).toBe('안녕하세요, 도움이 필요하신가요?');
    expect(result.hasNoReply).toBe(false);
    expect(result.hasSilentReply).toBe(false);
    expect(result.hasHeartbeat).toBe(false);
    expect(result.needsDisclaimer).toBe(false);
    expect(result.needsQuote).toBe(false);
  });

  it('NO_REPLY 토큰을 추출한다', () => {
    const result = extractControlTokens(`${CONTROL_TOKENS.NO_REPLY}`);

    expect(result.hasNoReply).toBe(true);
    expect(result.tokens).toContain(CONTROL_TOKENS.NO_REPLY);
    expect(result.cleanContent).toBe('');
  });

  it('SILENT_REPLY 토큰을 추출한다', () => {
    const result = extractControlTokens(`응답 내용${CONTROL_TOKENS.SILENT_REPLY}`);

    expect(result.hasSilentReply).toBe(true);
    expect(result.cleanContent).toBe('응답 내용');
  });

  it('HEARTBEAT_OK 토큰을 추출한다', () => {
    const result = extractControlTokens(`처리 중${CONTROL_TOKENS.HEARTBEAT_OK}입니다`);

    expect(result.hasHeartbeat).toBe(true);
    expect(result.cleanContent).toBe('처리 중입니다');
  });

  it('ATTACH_DISCLAIMER 토큰을 추출한다', () => {
    const result = extractControlTokens(`AAPL 주가 분석${CONTROL_TOKENS.ATTACH_DISCLAIMER}`);

    expect(result.needsDisclaimer).toBe(true);
    expect(result.cleanContent).toBe('AAPL 주가 분석');
  });

  it('ATTACH_QUOTE 토큰을 추출한다', () => {
    const result = extractControlTokens(`시세 정보${CONTROL_TOKENS.ATTACH_QUOTE}`);

    expect(result.needsQuote).toBe(true);
  });

  it('복합 토큰을 모두 추출한다', () => {
    const input = `분석 결과${CONTROL_TOKENS.ATTACH_DISCLAIMER}${CONTROL_TOKENS.ATTACH_QUOTE}입니다`;
    const result = extractControlTokens(input);

    expect(result.tokens).toHaveLength(2);
    expect(result.needsDisclaimer).toBe(true);
    expect(result.needsQuote).toBe(true);
    expect(result.cleanContent).toBe('분석 결과입니다');
  });

  it('토큰 제거 후 과도한 줄바꿈을 정리한다', () => {
    const input = `첫 줄\n\n\n${CONTROL_TOKENS.HEARTBEAT_OK}\n\n\n두 번째 줄`;
    const result = extractControlTokens(input);

    expect(result.cleanContent).toBe('첫 줄\n\n두 번째 줄');
  });
});
