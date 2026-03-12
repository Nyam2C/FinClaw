import type { MemoryEntry, SessionKey, Timestamp } from '@finclaw/types';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { EmbeddingProvider } from '../embeddings/provider.js';
import { embedBatchWithCache } from './embeddings.js';

// ─── Types ───

export interface MemoryChunk {
  readonly id: string;
  readonly memoryId: string;
  readonly text: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly model: string;
}

interface MemoryRow {
  id: string;
  session_key: string;
  content: string;
  type: string;
  hash: string;
  created_at: number;
  metadata: string;
}

interface ChunkRow {
  id: string;
  memory_id: string;
  text: string;
  start_line: number;
  end_line: number;
  model: string;
}

// ─── chunkMarkdown ───

export function chunkMarkdown(
  text: string,
  maxTokens = 512,
  overlap = 64,
): Array<{ text: string; startLine: number; endLine: number }> {
  const maxChars = maxTokens * 4;
  const overlapChars = overlap * 4;
  const lines = text.split('\n');
  const chunks: Array<{ text: string; startLine: number; endLine: number }> = [];

  let currentChunk = '';
  let startLine = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const addition = currentChunk.length === 0 ? line : '\n' + line;

    if (currentChunk.length + addition.length > maxChars && currentChunk.length > 0) {
      chunks.push({ text: currentChunk, startLine, endLine: i - 1 });

      const carry = currentChunk.slice(-overlapChars);
      const carryNewlines = (carry.match(/\n/g) || []).length;
      startLine = Math.max(0, i - carryNewlines);
      currentChunk = carry + '\n' + line;
    } else {
      currentChunk += addition;
    }
  }

  if (currentChunk.length > 0) {
    chunks.push({
      text: currentChunk,
      startLine,
      endLine: lines.length - 1,
    });
  }

  return chunks;
}

// ─── Helpers ───

function rowToEntry(row: MemoryRow): MemoryEntry {
  return {
    id: row.id,
    sessionKey: row.session_key as SessionKey,
    content: row.content,
    type: row.type as MemoryEntry['type'],
    createdAt: row.created_at as Timestamp,
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
  };
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

// ─── CRUD ───

export function addMemory(db: DatabaseSync, entry: MemoryEntry): void {
  const hash = sha256(entry.content);

  // Duplicate check
  const existing = db.prepare('SELECT id FROM memories WHERE hash = ?').get(hash) as unknown as
    | { id: string }
    | undefined;
  if (existing) {
    return;
  }

  const meta = entry.metadata ? JSON.stringify(entry.metadata) : '{}';

  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO memories (id, session_key, content, type, hash, created_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      entry.id,
      entry.sessionKey as string,
      entry.content,
      entry.type,
      hash,
      entry.createdAt as number,
      meta,
    );

    const chunks = chunkMarkdown(entry.content);
    const insertChunk = db.prepare(
      `INSERT INTO memory_chunks (id, memory_id, text, start_line, end_line, model, created_at)
       VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
    );
    const insertFts = db.prepare(
      `INSERT INTO memory_chunks_fts (text, id, memory_id) VALUES (?, ?, ?)`,
    );

    for (const chunk of chunks) {
      const chunkId = randomUUID();
      insertChunk.run(
        chunkId,
        entry.id,
        chunk.text,
        chunk.startLine,
        chunk.endLine,
        entry.createdAt as number,
      );
      insertFts.run(chunk.text, chunkId, entry.id);
    }

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getMemory(db: DatabaseSync, id: string): MemoryEntry | null {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as unknown as
    | MemoryRow
    | undefined;
  return row ? rowToEntry(row) : null;
}

export function getMemoriesBySession(
  db: DatabaseSync,
  sessionKey: SessionKey,
  options?: { type?: MemoryEntry['type']; limit?: number },
): MemoryEntry[] {
  let sql = 'SELECT * FROM memories WHERE session_key = ?';
  const params: (string | number)[] = [sessionKey as string];

  if (options?.type) {
    sql += ' AND type = ?';
    params.push(options.type);
  }

  sql += ' ORDER BY created_at DESC';

  if (options?.limit) {
    sql += ' LIMIT ?';
    params.push(options.limit);
  }

  const rows = db.prepare(sql).all(...params) as unknown as MemoryRow[];
  return rows.map(rowToEntry);
}

export function deleteMemory(db: DatabaseSync, id: string): boolean {
  db.exec('BEGIN');
  try {
    // Get chunk IDs for manual vec0/FTS5 cleanup
    const chunkRows = db
      .prepare('SELECT id FROM memory_chunks WHERE memory_id = ?')
      .all(id) as unknown as Array<{ id: string }>;

    if (chunkRows.length > 0) {
      const ids = chunkRows.map((r) => r.id);
      const placeholders = ids.map(() => '?').join(',');

      // vec0 manual delete
      db.prepare(`DELETE FROM memory_chunks_vec WHERE chunk_id IN (${placeholders})`).run(...ids);

      // FTS5 manual delete
      db.prepare(`DELETE FROM memory_chunks_fts WHERE id IN (${placeholders})`).run(...ids);
    }

    // CASCADE deletes memory_chunks
    const result = db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    db.exec('COMMIT');
    return Number(result.changes) > 0;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function getMemoryChunks(db: DatabaseSync, memoryId: string): MemoryChunk[] {
  const rows = db
    .prepare('SELECT * FROM memory_chunks WHERE memory_id = ? ORDER BY start_line ASC')
    .all(memoryId) as unknown as ChunkRow[];

  return rows.map((row) => ({
    id: row.id,
    memoryId: row.memory_id,
    text: row.text,
    startLine: row.start_line,
    endLine: row.end_line,
    model: row.model,
  }));
}

// ─── Embedding-aware insert ───

function float32ToBuffer(arr: Float32Array): Buffer {
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

/**
 * Insert memory, then embed its chunks and store vectors.
 * If addMemory detects a duplicate, returns without embedding.
 */
export async function addMemoryWithEmbedding(
  db: DatabaseSync,
  entry: MemoryEntry,
  provider: EmbeddingProvider,
): Promise<void> {
  addMemory(db, entry);

  // Check if chunks were created (dupe skip → no chunks)
  const chunks = db
    .prepare('SELECT id, text FROM memory_chunks WHERE memory_id = ?')
    .all(entry.id) as unknown as Array<{ id: string; text: string }>;

  if (chunks.length === 0) {
    return;
  }

  const texts = chunks.map((c) => c.text);
  const embeddings = await embedBatchWithCache(db, texts, provider);

  const insertVec = db.prepare('INSERT INTO memory_chunks_vec (chunk_id, embedding) VALUES (?, ?)');
  const updateModel = db.prepare('UPDATE memory_chunks SET model = ? WHERE id = ?');

  for (let i = 0; i < chunks.length; i++) {
    const f32 = new Float32Array(embeddings[i]);
    insertVec.run(chunks[i].id, float32ToBuffer(f32));
    updateModel.run(provider.model, chunks[i].id);
  }
}
