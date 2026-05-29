import type { AgentId, SessionKey, Timestamp } from './common.js';

/**
 * 에이전트(워커) 프로필 — orchestrator-worker 워커 정의 (phase42).
 * model 은 인라인 (스킬 정의 파일에 모델명을 넣지 않음 → 프로필이 단일 출처).
 * systemPrompt·도구 허용목록 등 정적 정의는 agentDir 파일로 분리.
 * 이 프로필로 서브에이전트를 선택·호출하고, AgentRunParams 로 실행한다.
 * (동시성 제한은 spawn 레이어의 ConcurrencyLane 책임 — 프로필 필드 아님.)
 */
export interface AgentProfile {
  id: AgentId;
  name: string;
  model: ModelRef;
  agentDir: string;
}

/** 모델 참조 */
export interface ModelRef {
  provider: string;
  model: string;
}

/**
 * 에이전트 1회 실행 입력 — runner.execute 가 소비하는 실사용 형태.
 * temperature·maxTokens·tools 는 결정4(CLI 무시 SDK-era 필드)에서 제거됨.
 *
 * NOTE(phase43): orchestrator-worker 워커-spawn 형태 `{ profile, prompt }` 로의 전환은
 * consumer(gateway/scheduler/execution-adapter) + runner 마이그레이션과 함께 phase43 에서.
 * 현재는 아래 필드를 직접 소비하므로 type-first 선반영하지 않는다 (선반영 시 build 깨짐).
 */
export interface AgentRunParams {
  agentId: AgentId;
  sessionKey: SessionKey;
  model: ModelRef;
  systemPrompt: string;
  messages: ConversationMessage[];
  abortSignal?: AbortSignal;
}

/** 대화 메시지 — 대화 이력·provider 입력의 표준 표현 */
export interface ConversationMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentBlock[];
  name?: string;
}

/** 콘텐츠 블록 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean };

/** 도구 정의 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

/** 도구 호출 */
export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

/** 토큰 사용량 — provider 응답에서 누적, 비용 계산·관찰성에 사용 */
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
export interface AgentRunLog {
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
  /** Phase 30 A: 본 run 을 묶는 W3C trace ID (32 hex). */
  traceId?: string;
  /** Phase 30 A: 본 run 의 부모 span ID (16 hex; pipeline 진입 span). */
  parentSpanId?: string;
  /** Phase 30 D: RAG re-ranking 통계. */
  rerankMeta?: {
    readonly model: string;
    readonly scoresBefore: readonly number[];
    readonly scoresAfter: readonly number[];
    readonly swaps: number;
  };
  /** Phase 32 G1: CLI 발급 세션 ID (audit). */
  cliSessionId?: string;
  /** 실행 실패 시 에러 메시지 */
  error?: string;
  createdAt: Timestamp;
}
