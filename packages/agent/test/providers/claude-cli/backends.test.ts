import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLAUDE_BACKEND,
  resolveClaudeBackend,
  normalizeClaudeModel,
} from '../../../src/providers/claude-cli/backends.js';

describe('DEFAULT_CLAUDE_BACKEND', () => {
  it('clears ANTHROPIC_API_KEY env', () => {
    expect(DEFAULT_CLAUDE_BACKEND.clearEnv).toContain('ANTHROPIC_API_KEY');
    expect(DEFAULT_CLAUDE_BACKEND.clearEnv).toContain('ANTHROPIC_API_KEY_OLD');
  });

  it('uses --dangerously-skip-permissions for tool auto-approve', () => {
    expect(DEFAULT_CLAUDE_BACKEND.args).toContain('--dangerously-skip-permissions');
  });

  it('outputs json by default', () => {
    expect(DEFAULT_CLAUDE_BACKEND.output).toBe('json');
  });

  it('uses --session-id for multi-turn', () => {
    expect(DEFAULT_CLAUDE_BACKEND.sessionArg).toBe('--session-id');
    expect(DEFAULT_CLAUDE_BACKEND.sessionMode).toBe('always');
  });
});

describe('resolveClaudeBackend', () => {
  it('returns default when no override', () => {
    expect(resolveClaudeBackend()).toBe(DEFAULT_CLAUDE_BACKEND);
  });

  it('merges clearEnv (union)', () => {
    const merged = resolveClaudeBackend({ clearEnv: ['ANTHROPIC_BASE_URL'] });
    expect(merged.clearEnv).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_OLD', 'ANTHROPIC_BASE_URL']),
    );
  });
});

describe('normalizeClaudeModel', () => {
  it('aliases sonnet-4.5 to sonnet', () => {
    expect(normalizeClaudeModel('sonnet-4.5', DEFAULT_CLAUDE_BACKEND)).toBe('sonnet');
  });
  it('aliases case-insensitive', () => {
    expect(normalizeClaudeModel('CLAUDE-OPUS-4-6', DEFAULT_CLAUDE_BACKEND)).toBe('opus');
  });
  it('passes through unknown', () => {
    expect(normalizeClaudeModel('custom-x', DEFAULT_CLAUDE_BACKEND)).toBe('custom-x');
  });
});
