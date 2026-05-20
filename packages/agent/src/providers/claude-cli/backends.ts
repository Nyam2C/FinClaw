// packages/agent/src/providers/claude-cli/backends.ts

import type { CliBackendConfig } from './types.js';

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  opus: 'opus',
  'opus-4.6': 'opus',
  'opus-4.5': 'opus',
  'opus-4': 'opus',
  'claude-opus-4-6': 'opus',
  'claude-opus-4-5': 'opus',
  'claude-opus-4': 'opus',
  sonnet: 'sonnet',
  'sonnet-4.6': 'sonnet',
  'sonnet-4.5': 'sonnet',
  'claude-sonnet-4-6': 'sonnet',
  'claude-sonnet-4-5': 'sonnet',
  haiku: 'haiku',
  'haiku-3.5': 'haiku',
  'claude-haiku-3-5': 'haiku',
};

// OpenClaw 기본값 (cli-watchdog-defaults.ts 참조)
const FRESH_WATCHDOG = { noOutputTimeoutRatio: 0.6, minMs: 30_000, maxMs: 240_000 };
const RESUME_WATCHDOG = { noOutputTimeoutRatio: 0.4, minMs: 15_000, maxMs: 90_000 };

export const DEFAULT_CLAUDE_BACKEND: CliBackendConfig = {
  command: 'claude',
  args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions'],
  resumeArgs: [
    '-p',
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
    '--resume',
    '{sessionId}',
  ],
  output: 'json',
  input: 'arg',
  modelArg: '--model',
  modelAliases: CLAUDE_MODEL_ALIASES,
  sessionArg: '--session-id',
  sessionMode: 'always',
  sessionIdFields: ['session_id', 'sessionId', 'conversation_id', 'conversationId'],
  systemPromptArg: '--append-system-prompt',
  systemPromptMode: 'append',
  systemPromptWhen: 'first',
  // ★ 핵심: API 키를 비워서 claude CLI 가 OAuth/구독 인증을 사용하게 강제
  clearEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_OLD'],
  reliability: {
    watchdog: { fresh: FRESH_WATCHDOG, resume: RESUME_WATCHDOG },
  },
  serialize: true,
};

export function resolveClaudeBackend(override?: Partial<CliBackendConfig>): CliBackendConfig {
  if (!override) {
    return DEFAULT_CLAUDE_BACKEND;
  }
  return {
    ...DEFAULT_CLAUDE_BACKEND,
    ...override,
    args: override.args ?? DEFAULT_CLAUDE_BACKEND.args,
    resumeArgs: override.resumeArgs ?? DEFAULT_CLAUDE_BACKEND.resumeArgs,
    clearEnv: Array.from(
      new Set([...(DEFAULT_CLAUDE_BACKEND.clearEnv ?? []), ...(override.clearEnv ?? [])]),
    ),
    reliability: override.reliability ?? DEFAULT_CLAUDE_BACKEND.reliability,
  };
}

export function normalizeClaudeModel(modelId: string, backend: CliBackendConfig): string {
  const lower = modelId.trim().toLowerCase();
  return backend.modelAliases?.[lower] ?? modelId;
}
