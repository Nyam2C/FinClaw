import type { AgentId, SessionKey, Timestamp } from './common.js';

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

/**
 * 에이전트 실행 1회의 영속화 레코드 (감사 + RAG 소스).
 * DB 컬럼은 snake_case, 본 인터페이스는 camelCase 변환.
 */
export interface AgentRun {
  id: string;
  agentId: AgentId;
  prompt: string;
  output: string;
  /** tool_calls_json — 호출자가 JSON.stringify 한 raw 문자열 */
  toolCalls?: string;
  tokensInput?: number;
  tokensOutput?: number;
  durationMs?: number;
  /** Phase 24 routing 결과 모델명 */
  modelUsed?: string;
  /** Phase 24 role */
  role?: string;
  /** 저장된 memory.id 링크 (없으면 NULL) */
  memoryId?: string;
  /** Phase 29 B: RAG 인용 추출 결과 (응답이 의존한 memory.id 배열) */
  usedMemoryIds?: string[];
  /** 실행 실패 시 에러 메시지 */
  error?: string;
  createdAt: Timestamp;
}
