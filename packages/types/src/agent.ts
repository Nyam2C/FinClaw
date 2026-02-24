import type { AgentId, SessionKey } from './common.js';

/** 에이전트 프로필 */
export interface AgentProfile {
  id: AgentId;
  name: string;
  systemPrompt: string;
  model: ModelRef;
  skills: string[];
  maxConcurrent: number;
  agentDir?: string;
}

/** 모델 참조 */
export interface ModelRef {
  provider: string;
  model: string;
  contextWindow: number;
  maxOutputTokens: number;
}

/** 인증 프로필 */
export interface AuthProfile {
  provider: string;
  apiKey: string;
  organizationId?: string;
  baseUrl?: string;
  rotationIndex?: number;
}

/** 에이전트 실행 파라미터 */
export interface AgentRunParams {
  agentId: AgentId;
  sessionKey: SessionKey;
  model: ModelRef;
  systemPrompt: string;
  messages: ConversationMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxTokens?: number;
  abortSignal?: AbortSignal;
}

/** 대화 메시지 (LLM API용) */
export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  toolCallId?: string;
  name?: string;
}

/** 콘텐츠 블록 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; url: string; mimeType?: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

/** 도구 정의 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 에이전트 실행 결과 */
export interface AgentRunResult {
  text: string;
  toolCalls?: ToolCall[];
  usage?: TokenUsage;
  model: string;
  finishReason: 'end_turn' | 'max_tokens' | 'tool_use' | 'stop';
}

/** 도구 호출 */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** 토큰 사용량 */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}
