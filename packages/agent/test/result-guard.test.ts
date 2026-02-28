import { describe, it, expect } from 'vitest';
import {
  guardToolResult,
  FINANCIAL_REDACT_PATTERNS,
  type ResultGuardOptions,
} from '../src/agents/tools/result-guard.js';

const defaultOptions: ResultGuardOptions = {
  maxContentLength: 100_000,
  redactPatterns: [],
  allowHtml: false,
  redactFinancialData: true,
};

describe('guardToolResult', () => {
  it('null 결과를 "[No result returned]"으로 대체한다', () => {
    const result = guardToolResult(null, defaultOptions);

    expect(result.content).toBe('[No result returned]');
    expect(result.isError).toBe(false);
    expect(result.originalSize).toBe(0);
  });

  it('undefined 결과를 "[No result returned]"으로 대체한다', () => {
    const result = guardToolResult(undefined, defaultOptions);

    expect(result.content).toBe('[No result returned]');
  });

  it('정상 결과를 그대로 통과시킨다', () => {
    const result = guardToolResult({ content: 'hello', isError: false }, defaultOptions);

    expect(result.content).toBe('hello');
    expect(result.isError).toBe(false);
    expect(result.wasTruncated).toBe(false);
    expect(result.wasRedacted).toBe(false);
    expect(result.originalSize).toBe(5);
    expect(result.guardedSize).toBe(5);
  });

  it('maxContentLength 초과 시 truncation한다', () => {
    const longContent = 'x'.repeat(200);
    const result = guardToolResult(
      { content: longContent, isError: false },
      { ...defaultOptions, maxContentLength: 100 },
    );

    expect(result.wasTruncated).toBe(true);
    expect(result.content).toContain('[truncated]');
    expect(result.originalSize).toBe(200);
  });

  it('카드번호를 마스킹한다', () => {
    const result = guardToolResult(
      { content: 'Card: 4111-1111-1111-1111', isError: false },
      defaultOptions,
    );

    expect(result.wasRedacted).toBe(true);
    expect(result.content).not.toContain('4111');
    expect(result.content).toContain('[REDACTED]');
  });

  it('SSN을 마스킹한다', () => {
    const result = guardToolResult({ content: 'SSN: 123-45-6789', isError: false }, defaultOptions);

    expect(result.wasRedacted).toBe(true);
    expect(result.content).toContain('[REDACTED]');
  });

  it('redactFinancialData=false이면 금융 데이터를 마스킹하지 않는다', () => {
    const result = guardToolResult(
      { content: 'Card: 4111-1111-1111-1111', isError: false },
      { ...defaultOptions, redactFinancialData: false },
    );

    expect(result.wasRedacted).toBe(false);
    expect(result.content).toContain('4111');
  });

  it('사용자 정의 redact 패턴을 적용한다', () => {
    const result = guardToolResult(
      { content: 'API key: sk-1234abcd', isError: false },
      { ...defaultOptions, redactPatterns: [/sk-[a-zA-Z0-9]+/g] },
    );

    expect(result.wasRedacted).toBe(true);
    expect(result.content).not.toContain('sk-1234abcd');
  });

  it('allowHtml=false이면 HTML 태그를 제거한다', () => {
    const result = guardToolResult(
      { content: '<b>bold</b> <script>alert(1)</script>', isError: false },
      defaultOptions,
    );

    expect(result.content).not.toContain('<b>');
    expect(result.content).not.toContain('<script>');
    expect(result.content).toContain('bold');
  });

  it('allowHtml=true이면 HTML 태그를 유지한다', () => {
    const result = guardToolResult(
      { content: '<b>bold</b>', isError: false },
      { ...defaultOptions, allowHtml: true },
    );

    expect(result.content).toContain('<b>');
  });

  it('JSON 제어 문자를 제거한다 (탭/개행은 유지)', () => {
    const result = guardToolResult(
      { content: 'hello\u0000\tworld\nfoo\u0001bar', isError: false },
      { ...defaultOptions, redactFinancialData: false },
    );

    expect(result.content).toBe('hello\tworld\nfoobar');
  });
});

describe('FINANCIAL_REDACT_PATTERNS', () => {
  it('3종의 패턴이 정의되어 있다', () => {
    expect(FINANCIAL_REDACT_PATTERNS).toHaveLength(3);
  });
});
