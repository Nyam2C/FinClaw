// @finclaw/storage — storage & memory layer
import type {
  AgentId,
  ConversationRecord,
  MemoryEntry,
  SearchQuery,
  SearchResult,
  SessionKey,
  StorageAdapter,
  Timestamp,
} from '@finclaw/types';
import type { Database, DatabaseOptions } from './database.js';
import type { EmbeddingProvider } from './embeddings/provider.js';
import type { ChunkSearchResult, HybridSearchOptions } from './search/hybrid.js';
import type { MarketCacheEntry } from './tables/market-cache.js';
import type { MemoryChunk } from './tables/memories.js';
import { openDatabase } from './database.js';
import { searchFts } from './search/fts.js';
import { mergeHybridResults } from './search/hybrid.js';
import { searchVector } from './search/vector.js';
import { createConversation, getConversation } from './tables/conversations.js';
import { CACHE_TTL } from './tables/market-cache.js';
import { addMemory, getMemory, addMemoryWithEmbedding } from './tables/memories.js';
import { chunkMarkdown } from './tables/memories.js';

// re-exports
export { openDatabase, type Database, type DatabaseOptions };
export { chunkMarkdown, type MemoryChunk };
export { CACHE_TTL, type MarketCacheEntry };
export { type EmbeddingProvider } from './embeddings/provider.js';
export {
  createEmbeddingProvider,
  type EmbeddingMode,
  type EmbeddingConfig,
} from './embeddings/provider.js';
export {
  mergeHybridResults,
  type ChunkSearchResult,
  type HybridSearchOptions,
} from './search/hybrid.js';
export { searchFts } from './search/fts.js';
export { searchVector } from './search/vector.js';
export { atomicReindex } from './reindex.js';
export {
  getCachedData,
  setCachedData,
  getStaleCachedData,
  purgeExpiredCache,
} from './tables/market-cache.js';
export { updateAlertTrigger } from './tables/alerts.js';

// ─── StorageAdapter factory ───

export interface StorageOptions {
  dbPath: string;
  enableWAL?: boolean;
  embeddingProvider?: EmbeddingProvider;
}

// NOTE(review-1 R-2): duplicates conversations.ts type — will be removed with LIKE fallback
interface ConversationRow {
  id: string;
  agent_id: string;
  created_at: number;
  updated_at: number;
  metadata: string;
}

// NOTE(review-1 R-2): duplicates memories.ts type — same as above
interface MemoryRow {
  id: string;
  session_key: string;
  content: string;
  type: string;
  created_at: number;
  metadata: string;
}

export function createStorage(options: StorageOptions): StorageAdapter {
  const database = openDatabase({
    path: options.dbPath,
    enableWAL: options.enableWAL,
  });
  const provider = options.embeddingProvider;

  return {
    async initialize(): Promise<void> {
      // DB already initialized in openDatabase — no-op
    },

    async close(): Promise<void> {
      database.close();
    },

    async saveConversation(record: ConversationRecord): Promise<void> {
      createConversation(database.db, record);
    },

    async getConversation(sessionKey: SessionKey): Promise<ConversationRecord | null> {
      return getConversation(database.db, sessionKey);
    },

    async searchConversations(query: SearchQuery): Promise<SearchResult[]> {
      let sql = 'SELECT * FROM conversations WHERE 1=1';
      const params: (string | number)[] = [];

      if (query.sessionKey) {
        sql += ' AND id = ?';
        params.push(query.sessionKey as string);
      }
      if (query.agentId) {
        sql += ' AND agent_id = ?';
        params.push(query.agentId as string);
      }
      if (query.fromDate) {
        sql += ' AND updated_at >= ?';
        params.push(query.fromDate as number);
      }
      if (query.toDate) {
        sql += ' AND updated_at <= ?';
        params.push(query.toDate as number);
      }

      sql += ' ORDER BY updated_at DESC';

      if (query.limit) {
        sql += ' LIMIT ?';
        params.push(query.limit);
      }
      if (query.offset) {
        sql += ' OFFSET ?';
        params.push(query.offset);
      }

      const rows = database.db.prepare(sql).all(...params) as unknown as ConversationRow[];

      return rows.map((row) => ({
        record: {
          sessionKey: row.id as SessionKey,
          agentId: row.agent_id as AgentId,
          messages: [],
          createdAt: row.created_at as Timestamp,
          updatedAt: row.updated_at as Timestamp,
          metadata: JSON.parse(row.metadata) as Record<string, unknown>,
        },
        score: 1,
      }));
    },

    async saveMemory(entry: MemoryEntry): Promise<void> {
      if (provider) {
        await addMemoryWithEmbedding(database.db, entry, provider);
      } else {
        addMemory(database.db, entry);
      }
    },

    async searchMemory(query: string, limit?: number): Promise<MemoryEntry[]> {
      if (provider) {
        // Hybrid search: vector + FTS in parallel → merge → deduplicate
        const effectiveLimit = limit ?? 10;
        const [vecResults, ftsResults] = await Promise.all([
          searchVector(database.db, query, provider, effectiveLimit * 2),
          Promise.resolve(searchFts(database.db, query, effectiveLimit * 2)),
        ]);

        const merged = mergeHybridResults(vecResults, ftsResults, {
          limit: effectiveLimit * 2,
        });

        // Deduplicate by memoryId and resolve full entries
        const seen = new Set<string>();
        const entries: MemoryEntry[] = [];
        // NOTE(review-2 I-14): N+1 getMemory — acceptable, limit defaults to 10
        for (const result of merged) {
          if (seen.has(result.memoryId)) {
            continue;
          }
          seen.add(result.memoryId);
          const entry = getMemory(database.db, result.memoryId);
          if (entry) {
            entries.push(entry);
          }
          if (entries.length >= effectiveLimit) {
            break;
          }
        }
        return entries;
      }

      // Fallback: basic LIKE search
      let sql = 'SELECT * FROM memories WHERE content LIKE ?';
      const params: (string | number)[] = [`%${query}%`];

      sql += ' ORDER BY created_at DESC';

      if (limit) {
        sql += ' LIMIT ?';
        params.push(limit);
      }

      const rows = database.db.prepare(sql).all(...params) as unknown as MemoryRow[];

      return rows.map((row) => ({
        id: row.id,
        sessionKey: row.session_key as SessionKey,
        content: row.content,
        type: row.type as MemoryEntry['type'],
        createdAt: row.created_at as Timestamp,
        metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      }));
    },
  };
}
