import type { MemoryEntry, SessionKey, Timestamp } from '@finclaw/types';
import { renameSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { EmbeddingProvider } from './embeddings/provider.js';
import { openDatabase } from './database.js';
import { addMemoryWithEmbedding } from './tables/memories.js';

interface MemoryRow {
  id: string;
  session_key: string;
  content: string;
  type: string;
  hash: string;
  created_at: number;
  metadata: string;
}

/**
 * Atomic reindex: rebuild all embeddings in a temporary database,
 * then atomically swap it with the original.
 */
export async function atomicReindex(dbPath: string, provider: EmbeddingProvider): Promise<void> {
  const tmpPath = dbPath + '.reindex.tmp';

  try {
    // Open original DB (read-only source)
    const origDb = new DatabaseSync(dbPath, { readOnly: true });
    const rows = origDb
      .prepare('SELECT * FROM memories ORDER BY created_at ASC')
      .all() as unknown as MemoryRow[];
    origDb.close();

    // Open tmp DB with full schema
    const tmpDatabase = openDatabase({ path: tmpPath, enableWAL: false });

    for (const row of rows) {
      const entry: MemoryEntry = {
        id: row.id,
        sessionKey: row.session_key as SessionKey,
        content: row.content,
        type: row.type as MemoryEntry['type'],
        createdAt: row.created_at as Timestamp,
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      };
      await addMemoryWithEmbedding(tmpDatabase.db, entry, provider);
    }

    tmpDatabase.close();

    // Atomic swap
    renameSync(tmpPath, dbPath);

    // Clean up WAL/SHM from original if they exist
    for (const ext of ['-wal', '-shm']) {
      try {
        unlinkSync(dbPath + ext);
      } catch {
        // may not exist
      }
    }
  } catch (err) {
    // Cleanup tmp on failure
    try {
      unlinkSync(tmpPath);
    } catch {
      // may not exist
    }
    throw err;
  }
}
