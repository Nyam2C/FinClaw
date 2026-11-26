import type { AgentId, Timestamp } from './common.js';

/**
 * 에이전트(워커) 프로필 — orchestrator-worker 워커 정의 (phase42).
 * model 은 인라인 (스킬 정의 파일에 모델명을 넣지 않음 → 프로필이 단일 출처).
 * systemPrompt·도구 허용목록 등 정적 정의는 agentDir 파일로 분리.
 * 이 프로필로 서브에이전트를 선택·호출한다 (실행은 AgentDriver 1-shot).
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
// 저장된 assistant/tool 행에는 프로바이더 블록이 받은 그대로 들어간다 (thinking, tool_result{tool_use_id} 등).
// 위 유니온에 없는 type 도 있을 수 있으니, 읽는 쪽은 아는 type 만 골라 쓴다.

/** 도구 정의 */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
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

/** 에이전트 run 종료 오류 분류 (AgentEvent error.reason · chat.stream.error reason). */
export type AgentErrorReason =
  | 'aborted'
  | 'timeout' // 스트림 무활동/overall 워치독, lane 대기 실패
  | 'auth' // 401/403 — 키가 없거나 틀림
  | 'rate_limit' // 429 (SDK 재시도 후에도)
  | 'refusal' // stop_reason refusal — 재시도하지 않는다
  | 'budget' // run 토큰 예산 초과
  | 'context_overflow' // stop_reason model_context_window_exceeded — 다음 턴에 컨텍스트 회전
  | 'unknown';
