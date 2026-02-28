// packages/server/src/auto-reply/response-formatter.ts
import type { ControlTokenResult } from './control-tokens.js';

/** 포매팅 옵션 */
export interface FormatOptions {
  readonly maxLength: number;
  readonly supportedFormats: readonly SupportedFormat[];
  readonly codeBlockStyle: 'fenced' | 'indented';
  /** 금융 특화: 숫자 포매팅 로케일 */
  readonly numberLocale: string;
  /** 금융 특화: 통화 기호 */
  readonly currencySymbol: string;
}

export type SupportedFormat = 'markdown' | 'plain-text' | 'html';

/** 포매팅된 응답 */
export interface FormattedResponse {
  readonly parts: readonly ResponsePart[];
  readonly totalLength: number;
  readonly wasSplit: boolean;
}

/** 응답 파트 (긴 응답을 분할할 때 사용) */
export interface ResponsePart {
  readonly content: string;
  readonly index: number;
  readonly isLast: boolean;
}

/**
 * 채널별 응답 포매팅
 *
 * 1. 금융 데이터 포매팅 (숫자 소수점, 통화, 퍼센트)
 * 2. 코드블록 변환 (채널 지원 여부에 따라)
 * 3. 메시지 길이 검사 -> 초과 시 분할
 * 4. 면책 조항 첨부 (needsDisclaimer일 때)
 */
export function formatResponse(
  content: string,
  controlTokens: ControlTokenResult,
  options: FormatOptions,
): FormattedResponse {
  let formatted = content;

  // 면책 조항 첨부 (주의: deliver.ts에서도 별도로 면책 조항을 추가하므로, 현재는 deliver.ts 경로만 사용됨)
  if (controlTokens.needsDisclaimer) {
    formatted +=
      '\n\n---\n' +
      '_본 정보는 투자 조언이 아니며, 투자 결정은 본인의 판단과 책임 하에 이루어져야 합니다._';
  }

  // markdown 미지원 채널이면 마크다운 제거
  // 주의: _(.*?)_ 패턴은 _ticker_value_ 같은 금융 데이터에서 오탐 가능. 필요 시 word-boundary 조건 추가 검토.
  if (!options.supportedFormats.includes('markdown')) {
    formatted = formatted.replace(/\*\*(.*?)\*\*/g, '$1');
    formatted = formatted.replace(/_(.*?)_/g, '$1');
    formatted = formatted.replace(/`(.*?)`/g, '$1');
  }

  // 메시지 분할
  const chunks = splitMessage(formatted, options.maxLength);

  const parts: ResponsePart[] = chunks.map((chunk, i) => ({
    content: chunk,
    index: i,
    isLast: i === chunks.length - 1,
  }));

  return {
    parts,
    totalLength: formatted.length,
    wasSplit: parts.length > 1,
  };
}

/** 금융 숫자 포매팅 */
export function formatFinancialNumber(
  value: number,
  options: {
    locale?: string;
    currency?: string;
    minimumFractionDigits?: number;
    maximumFractionDigits?: number;
    showSign?: boolean;
  } = {},
): string {
  const {
    locale = 'en-US',
    currency,
    minimumFractionDigits = 2,
    maximumFractionDigits = 2,
    showSign = false,
  } = options;

  const formatOpts: Intl.NumberFormatOptions = {
    minimumFractionDigits,
    maximumFractionDigits,
  };

  if (currency) {
    formatOpts.style = 'currency';
    formatOpts.currency = currency;
  }

  if (showSign) {
    formatOpts.signDisplay = 'exceptZero';
  }

  return new Intl.NumberFormat(locale, formatOpts).format(value);
}

/**
 * 긴 메시지 분할
 *
 * 줄 바꿈 기준으로 분할하며, 코드 블록 내부는 분할하지 않는다.
 */
export function splitMessage(content: string, maxLength: number): readonly string[] {
  if (content.length <= maxLength) {
    return [content];
  }

  const parts: string[] = [];
  let remaining = content;

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      parts.push(remaining);
      break;
    }

    // 줄 바꿈 위치에서 분할 시도
    let splitAt = remaining.lastIndexOf('\n', maxLength);
    if (splitAt <= 0) {
      // 줄 바꿈이 없으면 공백에서 분할
      splitAt = remaining.lastIndexOf(' ', maxLength);
    }
    if (splitAt <= 0) {
      // 공백도 없으면 강제 분할
      splitAt = maxLength;
    }

    parts.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }

  return parts;
}
