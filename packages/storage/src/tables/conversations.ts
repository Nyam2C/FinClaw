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
  const msg: ConversationMessage = {
    role: row.role as ConversationMessage['role'],
    content: tryParseContent(row.content),
  };
  if (row.tool_calls) {
    const parsed = JSON.parse(row.tool_calls) as Array<{ id: string }>;
    if (parsed.length > 0) {
      msg.toolCallId = parsed[0].id;
    }
  }
  return msg;
}

// NOTE(review-1 R-3): duplicated in messages.ts
function tryParseContent(s: string): string | ContentBlock[] {
  if (s.startsWith('[')) {
    try {
      return JSON.parse(s) as ContentBlock[];
    } catch {
      // not JSON array
    }
  }
  return s;
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

export function createConversation(db: DatabaseSync, record: ConversationRecord): void {
  const insertConv = db.prepare(
    `INSERT INTO conversations (id, title, agent_id, channel_id, created_at, updated_at, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertMsg = db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, tool_calls, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  const meta = record.metadata ? JSON.stringify(record.metadata) : '{}';

  db.exec('BEGIN');
  try {
    insertConv.run(
      record.sessionKey,
      null,
      record.agentId,
      null,
      record.createdAt as number,
      record.updatedAt as number,
      meta,
    );

    for (const msg of record.messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const toolCalls = extractToolCalls(msg);
      insertMsg.run(
        crypto.randomUUID(),
        record.sessionKey,
        msg.role,
        content,
        toolCalls,
        null,
        record.updatedAt as number,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

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
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(sessionKey as string) as unknown as MessageRow[];
  const messages = msgRows.map(messageRowToMessage);

  return rowToRecord(row, messages);
}

export function updateConversation(
  db: DatabaseSync,
  sessionKey: SessionKey,
  updates: { title?: string; metadata?: Record<string, unknown> },
): void {
  const parts: string[] = ['updated_at = ?'];
  const params: (string | number)[] = [Date.now()];

  if (updates.title !== undefined) {
    parts.push('title = ?');
    params.push(updates.title);
  }
  if (updates.metadata !== undefined) {
    parts.push('metadata = ?');
    params.push(JSON.stringify(updates.metadata));
  }

  params.push(sessionKey as string);
  db.prepare(`UPDATE conversations SET ${parts.join(', ')} WHERE id = ?`).run(...params);
}

export function deleteConversation(db: DatabaseSync, sessionKey: SessionKey): boolean {
  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(sessionKey as string);
  return Number(result.changes) > 0;
}

/**
 * 대화 세션 전체를 갱신(존재 시)하거나 생성(없을 시)한다.
 *
 * 동일 sessionKey로 여러 번 호출해도 멱등적이며, 기존 메시지는
 * 제거되고 payload.messages로 대체된다. Phase 21 auto-reply 파이프라인이
 * 매 턴마다 최신 대화 이력 전체를 저장할 때 사용한다.
 */
export function upsertConversation(
  db: DatabaseSync,
  payload: {
    readonly sessionKey: SessionKey;
    readonly agentId: AgentId;
    readonly messages: readonly ConversationMessage[];
    readonly updatedAt: Timestamp;
    readonly metadata?: Record<string, unknown>;
  },
): void {
  const existing = db
    .prepare('SELECT id FROM conversations WHERE id = ?')
    .get(payload.sessionKey as string);

  if (!existing) {
    createConversation(db, {
      sessionKey: payload.sessionKey,
      agentId: payload.agentId,
      messages: payload.messages as ConversationMessage[],
      createdAt: payload.updatedAt,
      updatedAt: payload.updatedAt,
      metadata: payload.metadata,
    });
    return;
  }

  const insertMsg = db.prepare(
    `INSERT INTO messages (id, conversation_id, role, content, tool_calls, token_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM messages WHERE conversation_id = ?').run(payload.sessionKey as string);

    const updateParts: string[] = ['updated_at = ?', 'agent_id = ?'];
    const updateParams: (string | number)[] = [
      payload.updatedAt as number,
      payload.agentId as string,
    ];
    if (payload.metadata !== undefined) {
      updateParts.push('metadata = ?');
      updateParams.push(JSON.stringify(payload.metadata));
    }
    updateParams.push(payload.sessionKey as string);
    db.prepare(`UPDATE conversations SET ${updateParts.join(', ')} WHERE id = ?`).run(
      ...updateParams,
    );

    for (const msg of payload.messages) {
      const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
      const toolCalls = extractToolCalls(msg);
      insertMsg.run(
        crypto.randomUUID(),
        payload.sessionKey as string,
        msg.role,
        content,
        toolCalls,
        null,
        payload.updatedAt as number,
      );
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function listConversations(
  db: DatabaseSync,
  options?: { agentId?: AgentId; limit?: number; offset?: number },
): ConversationRecord[] {
  let sql = 'SELECT * FROM conversations';
  const params: (string | number)[] = [];

  if (options?.agentId) {
    sql += ' WHERE agent_id = ?';
    params.push(options.agentId as string);
  }

  sql += ' ORDER BY updated_at DESC';

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }
  if (options?.offset) {
    sql += ' OFFSET ?';
    params.push(options.offset);
  }

  const rows = db.prepare(sql).all(...params) as unknown as ConversationRow[];

  return rows.map((row) => rowToRecord(row, []));
}
