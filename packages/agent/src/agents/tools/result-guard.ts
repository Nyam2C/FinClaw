import type { ToolResult } from './registry.js';

// ── 타입 ──

/** 가드된 도구 결과 */
export interface GuardedToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly wasTruncated: boolean;
  readonly wasRedacted: boolean;
  readonly originalSize: number;
  readonly guardedSize: number;
}

/** 결과 가드 옵션 */
export interface ResultGuardOptions {
  readonly maxContentLength: number; // 기본: 100_000 chars
  readonly redactPatterns: readonly RegExp[];
  readonly allowHtml: boolean;
  /** 금융 특화: 계좌번호/카드번호 자동 마스킹 */
  readonly redactFinancialData: boolean;
}

// ── 내장 금융 데이터 마스킹 패턴 ──

export const FINANCIAL_REDACT_PATTERNS: readonly RegExp[] = [
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, // 카드번호
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b\d{10,14}\b/g, // 계좌번호 (10-14자리)
];

// ── HTML 태그 제거 ──

const HTML_TAG_RE = /<[^>]+>/g;

// ── 메인 함수 ──

/**
 * 도구 실행 결과 가드
 *
 * 1. null/undefined → "[No result returned]"
 * 2. 비문자열 → JSON.stringify
 * 3. JSON 제어 문자 제거 (탭/개행/CR 제외)
 * 4. 크기 제한 → 초과 시 truncation
 * 5. 민감 정보 마스킹
 * 6. HTML 새니타이즈
 * 7. 최종 GuardedToolResult 반환
 */
export function guardToolResult(
  result: ToolResult | null | undefined,
  options: ResultGuardOptions,
): GuardedToolResult {
  // 1. null/undefined 처리
  if (!result) {
    return {
      content: '[No result returned]',
      isError: false,
      wasTruncated: false,
      wasRedacted: false,
      originalSize: 0,
      guardedSize: 22,
    };
  }

  // 2. 문자열 변환
  let content: string;
  if (typeof result.content === 'string') {
    content = result.content;
  } else {
    try {
      content = JSON.stringify(result.content);
    } catch {
      content = String(result.content);
    }
  }

  const originalSize = content.length;
  let wasTruncated = false;
  let wasRedacted = false;

  // 3. JSON 제어 문자 제거 (탭 \t, 개행 \n, 캐리지리턴 \r 제외)
  // eslint-disable-next-line no-control-regex
  content = content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

  // 4. 크기 제한
  if (content.length > options.maxContentLength) {
    content = content.slice(0, options.maxContentLength) + '\n[truncated]';
    wasTruncated = true;
  }

  // 5. 민감 정보 마스킹
  // TODO: test를 제거하고 replace 결과 비교로 대체하면 RegExp 생성 3→1 가능 (review-1 이슈 1)
  // 5a. 사용자 정의 패턴
  for (const pattern of options.redactPatterns) {
    const re = new RegExp(pattern.source, pattern.flags);
    if (re.test(content)) {
      wasRedacted = true;
      content = content.replace(new RegExp(pattern.source, pattern.flags), '[REDACTED]');
    }
  }

  // 5b. 금융 데이터 마스킹
  if (options.redactFinancialData) {
    for (const pattern of FINANCIAL_REDACT_PATTERNS) {
      const re = new RegExp(pattern.source, pattern.flags);
      if (re.test(content)) {
        wasRedacted = true;
        content = content.replace(new RegExp(pattern.source, pattern.flags), '[REDACTED]');
      }
    }
  }

  // 6. HTML 새니타이즈
  if (!options.allowHtml) {
    content = content.replace(HTML_TAG_RE, '');
  }

  return {
    content,
    isError: result.isError,
    wasTruncated,
    wasRedacted,
    originalSize,
    guardedSize: content.length,
  };
}
