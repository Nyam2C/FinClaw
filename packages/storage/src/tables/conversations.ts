import { DatabaseSync } from 'node:sqlite';
import type {
  AgentId,
  ConversationMessage,
  ConversationRecord,
  ContentBlock,
  SessionKey,
  Timestamp,
} from '@finclaw/types';

// ─── Internal types ───

interface ConversationRow {
  id: string;
  title: string | null;
  agent_id: string;
  channel_id: string | null;
  created_at: number;
  updated_at: number;
  metadata: string;
}

interface MessageRow {
  id: string;
  conversation_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  token_count: number | null;
  created_at: number;
}

// ─── Helpers ───

function rowToRecord(row: ConversationRow, messages: ConversationMessage[]): ConversationRecord {
  return {
    sessionKey: row.id as SessionKey,
    agentId: row.agent_id as AgentId,
    messages,
    createdAt: row.created_at as Timestamp,
    updatedAt: row.updated_at as Timestamp,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

function messageRowToMessage(row: MessageRow): ConversationMessage {
  const role = row.role as ConversationMessage['role'];
  // 블록 배열은 assistant·tool 행에만 저장한다. user·system 행은 사용자가 `[...]` 를 쳤어도 문자열이다.
  const content = role === 'assistant' || role === 'tool' ? parseBlocks(row.content) : row.content;
  return { role, content };
}

/** JSON 블록 배열(`[{type: ...}, ...]`)이면 풀고, 아니면(예전 텍스트 행) 문자열 그대로. */
function parseBlocks(s: string): string | ContentBlock[] {
  if (!s.startsWith('[')) {
    return s;
  }
  try {
    const parsed: unknown = JSON.parse(s);
    const isBlocks =
      Array.isArray(parsed) &&
      parsed.every((b) => typeof b === 'object' && b !== null && typeof b.type === 'string');
    return isBlocks ? (parsed as ContentBlock[]) : s;
  } catch {
    return s;
  }
}

function extractToolCalls(msg: ConversationMessage): string | null {
  if (typeof msg.content === 'string') {
    return null;
  }
  const blocks = msg.content as ContentBlock[];
  const toolUses = blocks.filter(
    (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
  );
  if (toolUses.length === 0) {
    return null;
  }
  return JSON.stringify(toolUses.map((b) => ({ id: b.id, name: b.name, input: b.input })));
}

// ─── CRUD ───

export function getConversation(
  db: DatabaseSync,
  sessionKey: SessionKey,
): ConversationRecord | null {
  const row = db
    .prepare('SELECT * FROM conversations WHERE id = ?')
    .get(sessionKey as string) as unknown as ConversationRow | undefined;
  if (!row) {
    return null;
  }

  const msgRows = db
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY rowid ASC')
    .all(sessionKey as string) as unknown as MessageRow[];
  const messages = msgRows.map(messageRowToMessage);

  return rowToRecord(row, messages);
}

export function deleteConversation(db: DatabaseSync, sessionKey: SessionKey): boolean {
  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(sessionKey as string);
  return Number(result.changes) > 0;
}

/**
 * 대화에 메시지 행을 **덧붙인다** (없으면 대화를 만든다). 기존 행은 건드리지 않는다 —
 * 트랜스크립트는 append-only 다 (plans/agent-core.md §3.2).
 * `metadata` 를 주면 통째로 교체한다. `messages` 가 비어 있으면 metadata·updated_at 만 갱신한다.
 */
export function appendMessages(
  db: DatabaseSync,
  payload: {
    readonly sessionKey: SessionKey;
    readonly agentId: AgentId;
    readonly messages: readonly ConversationMessage[];
    readonly at: Timestamp;
    readonly metadata?: Record<string, unknown>;
  },
): void {
  const key = payload.sessionKey as string;
  const at = payload.at as number;
  db.exec('BEGIN');
  try {
    const exists = db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(key);
    if (!exists) {
      db.prepare(
        `INSERT INTO conversations (id, title, agent_id, channel_id, created_at, updated_at, metadata)
         VALUES (?, NULL, ?, NULL, ?, ?, ?)`,
      ).run(key, payload.agentId as string, at, at, JSON.stringify(payload.metadata ?? {}));
    } else if (payload.metadata !== undefined) {
      db.prepare('UPDATE conversations SET updated_at = ?, metadata = ? WHERE id = ?').run(
        at,
        JSON.stringify(payload.metadata),
        key,
      );
    } else {
      db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(at, key);
    }
    const insertMsg = db.prepare(
      `INSERT INTO messages (id, conversation_id, role, content, tool_calls, token_count, created_at)
       VALUES (?, ?, ?, ?, ?, NULL, ?)`,
    );
    for (const msg of payload.messages) {
      insertMsg.run(
        crypto.randomUUID(),
        key,
        msg.role,
        typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        extractToolCalls(msg),
        at,
      );
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
