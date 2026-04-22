import type { ConversationMessage, ContentBlock } from '@finclaw/types';
import { DatabaseSync } from 'node:sqlite';

// ─── Types ───

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  token_count: number | null;
  created_at: number;
}

/** 감사용 도구 호출 레코드 — Phase 22에서 output/timestamp 포함 형태로 확장 */
export interface ToolCallRecord {
  readonly id?: string;
  readonly name: string;
  readonly input: unknown;
  readonly output?: string;
  readonly source?: string;
  readonly timestamp?: number;
  readonly durationMs?: number;
  readonly isError?: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  role: ConversationMessage['role'];
  content: string | ContentBlock[];
  toolCalls: ToolCallRecord[] | null;
  tokenCount: number | null;
  createdAt: number;
}

export interface GetToolCallHistoryOptions {
  readonly conversationId: string;
  readonly limit?: number;
  readonly since?: number;
}

// ─── Helpers ───

function rowToMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role as ConversationMessage['role'],
    content: tryParseContent(row.content),
    toolCalls: row.tool_calls ? (JSON.parse(row.tool_calls) as ToolCallRecord[]) : null,
    tokenCount: row.token_count,
    createdAt: row.created_at,
  };
}

// NOTE(review-1 R-3): duplicated in conversations.ts
function tryParseContent(s: string): string | ContentBlock[] {
  if (s.startsWith('[')) {
    try {
      return JSON.parse(s) as ContentBlock[];
    } catch {
      // not JSON
    }
  }
  return s;
}

// ─── CRUD ───

export function addMessage(
  db: DatabaseSync,
  conversationId: string,
  message: ConversationMessage,
  options?: { tokenCount?: number },
): string {
  const id = crypto.randomUUID();
  const now = Date.now();

  const content =
    typeof message.content === 'string' ? message.content : JSON.stringify(message.content);

  let toolCalls: string | null = null;
  if (typeof message.content !== 'string') {
    const blocks = message.content as ContentBlock[];
    const toolUses = blocks.filter(
      (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
    );
    if (toolUses.length > 0) {
      toolCalls = JSON.stringify(toolUses.map((b) => ({ id: b.id, name: b.name, input: b.input })));
    }
  }

  db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, tool_calls, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, conversationId, message.role, content, toolCalls, options?.tokenCount ?? null, now);

  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);

  return id;
}

export function getMessages(
  db: DatabaseSync,
  conversationId: string,
  options?: { limit?: number; offset?: number; order?: 'asc' | 'desc' },
): Message[] {
  const order = options?.order === 'desc' ? 'DESC' : 'ASC';
  let sql = `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ${order}`;
  const params: (string | number)[] = [conversationId];

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }
  if (options?.offset) {
    sql += ' OFFSET ?';
    params.push(options.offset);
  }

  const rows = db.prepare(sql).all(...params) as unknown as MessageRow[];
  return rows.map(rowToMessage);
}

export function getMessageCount(db: DatabaseSync, conversationId: string): number {
  const row = db
    .prepare('SELECT COUNT(*) as count FROM messages WHERE conversation_id = ?')
    .get(conversationId) as unknown as { count: number };
  return Number(row.count);
}

export function deleteMessage(db: DatabaseSync, messageId: string): boolean {
  const result = db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
  return Number(result.changes) > 0;
}

/**
 * Phase 22: 감사용 도구 호출 이력 조회.
 *
 * 어시스턴트 메시지의 `tool_calls` 컬럼(`[{id,name,input}]`)과 이어지는
 * tool 메시지의 tool_result 블록을 `toolUseId`로 페어링해 완전한 레코드를 조립한다.
 * 구 포맷 레코드는 output을 빈 문자열로 채워 하위 호환 유지.
 */
export function getToolCallHistory(
  db: DatabaseSync,
  opts: GetToolCallHistoryOptions,
): ToolCallRecord[] {
  const clauses = ['conversation_id = ?'];
  const params: (string | number)[] = [opts.conversationId];
  if (opts.since !== undefined) {
    clauses.push('created_at >= ?');
    params.push(opts.since);
  }
  const rows = db
    .prepare(
      `SELECT role, content, tool_calls, created_at FROM messages
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at ASC`,
    )
    .all(...params) as unknown as Array<{
    role: string;
    content: string;
    tool_calls: string | null;
    created_at: number;
  }>;

  // 1차 스캔: tool_result 블록에서 toolUseId -> output 매핑 수집
  const outputMap = new Map<string, { output: string; isError?: boolean; timestamp: number }>();
  for (const row of rows) {
    if (row.role !== 'tool') {
      continue;
    }
    try {
      const parsed = JSON.parse(row.content) as unknown;
      if (!Array.isArray(parsed)) {
        continue;
      }
      for (const block of parsed) {
        if (
          block &&
          typeof block === 'object' &&
          (block as { type?: unknown }).type === 'tool_result'
        ) {
          const b = block as { toolUseId?: string; content?: unknown; isError?: boolean };
          if (typeof b.toolUseId !== 'string') {
            continue;
          }
          outputMap.set(b.toolUseId, {
            output: typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? ''),
            isError: b.isError,
            timestamp: row.created_at,
          });
        }
      }
    } catch {
      // 손상된 JSON은 스킵
    }
  }

  // 2차 스캔: 어시스턴트의 tool_calls 레코드와 페어링
  const records: ToolCallRecord[] = [];
  for (const row of rows) {
    if (row.role !== 'assistant' || !row.tool_calls) {
      continue;
    }
    try {
      const parsed = JSON.parse(row.tool_calls) as unknown;
      if (!Array.isArray(parsed)) {
        continue;
      }
      for (const raw of parsed) {
        if (!raw || typeof raw !== 'object' || !('name' in raw)) {
          continue;
        }
        const r = raw as Record<string, unknown>;
        const id = typeof r.id === 'string' ? r.id : undefined;
        const match = id ? outputMap.get(id) : undefined;
        records.push({
          id,
          name: String(r.name),
          input: r.input ?? {},
          output: typeof r.output === 'string' ? r.output : (match?.output ?? ''),
          source: typeof r.source === 'string' ? r.source : undefined,
          timestamp:
            typeof r.timestamp === 'number' ? r.timestamp : (match?.timestamp ?? row.created_at),
          durationMs: typeof r.durationMs === 'number' ? r.durationMs : undefined,
          isError: typeof r.isError === 'boolean' ? r.isError : match?.isError,
        });
      }
    } catch {
      // 손상된 JSON은 스킵
    }
  }

  // 최근 limit개 (기본 100) 를 최신순으로 반환
  const limit = opts.limit ?? 100;
  return records.slice(-limit).toReversed();
}
