import { renameSync, unlinkSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import type { MemoryEntry, SessionKey, Timestamp } from '@finclaw/types';
import { openDatabase } from './database.js';
import type { EmbeddingProvider } from './embeddings/provider.js';
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
    // NOTE(review-2 I-10): no sqlite-vec — safe, only memories table queried (no vec0 access)
    const origDb = new DatabaseSync(dbPath, { readOnly: true });
    // Phase 29 C8: meta.last_reindex_provider 검사. 다른 provider 면 강제 전체 reindex (안내만).
    const lastProviderRow = origDb
      .prepare(`SELECT value FROM meta WHERE key = 'last_reindex_provider'`)
      .get() as { value: string } | undefined;
    const previousProvider = lastProviderRow?.value;
    if (previousProvider && previousProvider !== provider.id) {
      console.warn(
        `[reindex] provider changed: ${previousProvider} -> ${provider.id} - full reindex.`,
      );
    }
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

    // Phase 29 C8: 새 DB 에 last_reindex_provider 기록 (다음 reindex 시 비교용).
    tmpDatabase.db
      .prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`)
      .run('last_reindex_provider', provider.id);

    tmpDatabase.close();

    // Clean up WAL/SHM from original before rename to avoid stale files
    for (const ext of ['-wal', '-shm']) {
      try {
        unlinkSync(dbPath + ext);
      } catch {
        // may not exist
      }
    }

    // Atomic swap
    renameSync(tmpPath, dbPath);
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
