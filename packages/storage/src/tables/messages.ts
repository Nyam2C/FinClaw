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

export interface ToolCallRecord {
  id: string;
  name: string;
  input: unknown;
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
