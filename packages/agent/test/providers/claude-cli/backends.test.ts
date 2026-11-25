import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLAUDE_BACKEND,
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
    expect(DEFAULT_CLAUDE_BACKEND.args).toContain('json');
  });
});

describe('normalizeClaudeModel', () => {
  it('aliases claude-sonnet-4-6 to sonnet', () => {
    expect(normalizeClaudeModel('claude-sonnet-4-6', DEFAULT_CLAUDE_BACKEND)).toBe('sonnet');
  });
  it('aliases case-insensitive', () => {
    expect(normalizeClaudeModel('OPUS', DEFAULT_CLAUDE_BACKEND)).toBe('opus');
  });
  it('passes through unknown', () => {
    expect(normalizeClaudeModel('custom-x', DEFAULT_CLAUDE_BACKEND)).toBe('custom-x');
  });
});
