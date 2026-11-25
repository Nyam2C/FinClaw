import { describe, it, expect } from 'vitest';
import { DEFAULT_CLAUDE_BACKEND } from '../../../src/providers/claude-cli/backends.js';
import { parseCliJson } from '../../../src/providers/claude-cli/parsers.js';

describe('parseCliJson (claude format)', () => {
  it('parses claude CLI result format', () => {
    const stdout = JSON.stringify({
      type: 'result',
      result: '안녕하세요',
      session_id: 'sess_abc123',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
      is_error: false,
    });
    const r = parseCliJson(stdout, DEFAULT_CLAUDE_BACKEND);
    expect(r?.text).toBe('안녕하세요');
    expect(r?.sessionId).toBe('sess_abc123');
    expect(r?.usage?.input).toBe(10);
    expect(r?.usage?.output).toBe(5);
    expect(r?.usage?.cacheRead).toBe(100);
  });

  it('captures total_cost_usd (top-level) as usage.costUsd', () => {
    const stdout = JSON.stringify({
      type: 'result',
      result: 'ok',
      total_cost_usd: 0.0789,
      usage: { input_tokens: 4, output_tokens: 270 },
    });
    const r = parseCliJson(stdout, DEFAULT_CLAUDE_BACKEND);
    expect(r?.usage?.costUsd).toBe(0.0789);
  });

  it('returns undefined for empty stdout', () => {
    expect(parseCliJson('', DEFAULT_CLAUDE_BACKEND)).toBeUndefined();
  });

  it('returns undefined for invalid JSON', () => {
    expect(parseCliJson('not json', DEFAULT_CLAUDE_BACKEND)).toBeUndefined();
  });
});
