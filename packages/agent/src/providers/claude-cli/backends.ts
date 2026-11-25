// packages/agent/src/providers/claude-cli/backends.ts

import type { CliBackendConfig } from './types.js';

// 그 외 id(claude-opus-4-7 등)는 그대로 CLI 에 전달된다.
const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  opus: 'opus',
  sonnet: 'sonnet',
  'claude-sonnet-4-6': 'sonnet', // DEFAULT_MODEL
  haiku: 'haiku',
};

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
  modelArg: '--model',
  modelAliases: CLAUDE_MODEL_ALIASES,
  sessionIdFields: ['session_id', 'sessionId', 'conversation_id', 'conversationId'],
  systemPromptArg: '--append-system-prompt',
  systemPromptWhen: 'first',
  // ★ 핵심: API 키를 비워서 claude CLI 가 OAuth/구독 인증을 사용하게 강제
  clearEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_OLD'],
};

export function normalizeClaudeModel(modelId: string, backend: CliBackendConfig): string {
  const lower = modelId.trim().toLowerCase();
  return backend.modelAliases?.[lower] ?? modelId;
}
