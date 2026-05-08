import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { AgentId, AgentRun, Timestamp } from '@finclaw/types';

// ─── Row type ───

export interface AgentRunRow {
  id: string;
  agent_id: string;
  prompt: string;
  output: string;
  tool_calls_json: string | null;
  tokens_input: number | null;
  tokens_output: number | null;
  duration_ms: number | null;
  model_used: string | null;
  role: string | null;
  memory_id: string | null;
  /** Phase 29 B4: RAG 인용으로 응답이 의존한 memory.id 배열 (JSON.stringify 결과) */
  used_memory_ids: string | null;
  /** Phase 30 A8: 본 run 을 묶는 W3C trace ID (32 hex). nullable. */
  trace_id: string | null;
  /** Phase 30 A8: 본 run 의 부모 span ID (16 hex). pipeline 진입 span 의 spanId. */
  parent_span_id: string | null;
  /** Phase 30 D4: RAG re-rank 통계 (JSON.stringify 결과). null 이면 rerank 미사용. */
  rerank_meta: string | null;
  error: string | null;
  created_at: number;
}

// ─── Public types ───

export type { AgentRun } from '@finclaw/types';

/** addAgentRun 입력 — id/createdAt 은 함수 내부에서 생성 */
export interface AddAgentRunInput {
  agentId: AgentId;
  prompt: string;
  output: string;
  /** tool_calls_json — 직렬화는 호출자 책임 (이미 JSON 문자열) */
  toolCalls?: string;
  tokensInput?: number;
  tokensOutput?: number;
  durationMs?: number;
  modelUsed?: string;
  role?: string;
  memoryId?: string;
  /** Phase 29 B4: RAG 인용으로 응답이 의존한 memory.id 목록 (응답 후처리에서 채움) */
  usedMemoryIds?: string[];
  /** Phase 30 A8: 본 run 을 묶는 trace 컨텍스트. */
  traceId?: string;
  parentSpanId?: string;
  /** Phase 30 D4: rerank 통계 (storage 가 JSON.stringify). */
  rerankMeta?: {
    readonly model: string;
    readonly scoresBefore: readonly number[];
    readonly scoresAfter: readonly number[];
    readonly swaps: number;
  };
  error?: string;
}

export interface ListAgentRunsOptions {
  agentId?: AgentId;
  from?: Timestamp;
  to?: Timestamp;
  /** default 50, max 200 */
  limit?: number;
}

// ─── Helpers ───

function rowToAgentRun(row: AgentRunRow): AgentRun {
  return {
    id: row.id,
    agentId: row.agent_id as AgentId,
    prompt: row.prompt,
    output: row.output,
    toolCalls: row.tool_calls_json === null ? undefined : row.tool_calls_json,
    tokensInput: row.tokens_input === null ? undefined : row.tokens_input,
    tokensOutput: row.tokens_output === null ? undefined : row.tokens_output,
    durationMs: row.duration_ms === null ? undefined : row.duration_ms,
    modelUsed: row.model_used === null ? undefined : row.model_used,
    role: row.role === null ? undefined : row.role,
    memoryId: row.memory_id === null ? undefined : row.memory_id,
    usedMemoryIds:
      row.used_memory_ids === null ? undefined : (JSON.parse(row.used_memory_ids) as string[]),
    traceId: row.trace_id === null ? undefined : row.trace_id,
    parentSpanId: row.parent_span_id === null ? undefined : row.parent_span_id,
    rerankMeta:
      row.rerank_meta === null
        ? undefined
        : (JSON.parse(row.rerank_meta) as AgentRun['rerankMeta']),
    error: row.error === null ? undefined : row.error,
    createdAt: row.created_at as Timestamp,
  };
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// ─── CRUD ───

export function addAgentRun(db: DatabaseSync, input: AddAgentRunInput): AgentRun {
  const id = randomUUID();
  const createdAt = Date.now() as Timestamp;

  db.prepare(
    `INSERT INTO agent_runs
     (id, agent_id, prompt, output, tool_calls_json, tokens_input, tokens_output,
      duration_ms, model_used, role, memory_id, used_memory_ids,
      trace_id, parent_span_id, rerank_meta, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.agentId as string,
    input.prompt,
    input.output,
    input.toolCalls ?? null,
    input.tokensInput ?? null,
    input.tokensOutput ?? null,
    input.durationMs ?? null,
    input.modelUsed ?? null,
    input.role ?? null,
    input.memoryId ?? null,
    input.usedMemoryIds && input.usedMemoryIds.length > 0
      ? JSON.stringify(input.usedMemoryIds)
      : null,
    input.traceId ?? null,
    input.parentSpanId ?? null,
    input.rerankMeta ? JSON.stringify(input.rerankMeta) : null,
    input.error ?? null,
    createdAt as number,
  );

  const row = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as unknown as AgentRunRow;
  return rowToAgentRun(row);
}

export function getAgentRun(db: DatabaseSync, id: string): AgentRun | null {
  const row = db.prepare('SELECT * FROM agent_runs WHERE id = ?').get(id) as unknown as
    | AgentRunRow
    | undefined;
  return row ? rowToAgentRun(row) : null;
}

export function listAgentRuns(db: DatabaseSync, options: ListAgentRunsOptions = {}): AgentRun[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];

  if (options.agentId) {
    clauses.push('agent_id = ?');
    params.push(options.agentId as string);
  }
  if (options.from !== undefined) {
    clauses.push('created_at >= ?');
    params.push(options.from as number);
  }
  if (options.to !== undefined) {
    clauses.push('created_at <= ?');
    params.push(options.to as number);
  }

  let sql = 'SELECT * FROM agent_runs';
  if (clauses.length > 0) {
    sql += ` WHERE ${clauses.join(' AND ')}`;
  }
  sql += ' ORDER BY created_at DESC';

  const requestedLimit = options.limit ?? DEFAULT_LIMIT;
  const effectiveLimit = Math.min(Math.max(1, requestedLimit), MAX_LIMIT);
  sql += ' LIMIT ?';
  params.push(effectiveLimit);

  const rows = db.prepare(sql).all(...params) as unknown as AgentRunRow[];
  return rows.map(rowToAgentRun);
}

/**
 * agent_runs.memory_id 를 갱신하여 저장된 memory 와 링크.
 * runner 가 먼저 agent_runs 를 INSERT (memory_id NULL) 한 뒤,
 * memory 임베딩이 끝난 후 본 함수로 링크 기록.
 *
 * @returns 갱신 성공 여부 (해당 id 의 행이 존재했는지)
 */
export function linkMemoryToAgentRun(
  db: DatabaseSync,
  agentRunId: string,
  memoryId: string,
): boolean {
  const result = db
    .prepare('UPDATE agent_runs SET memory_id = ? WHERE id = ?')
    .run(memoryId, agentRunId);
  return result.changes > 0;
}
