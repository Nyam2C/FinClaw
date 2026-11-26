// @finclaw/storage — storage & memory layer
import type { ConversationRecord, SessionKey, StorageAdapter } from '@finclaw/types';
import type { Database } from './database.js';
import { openDatabase } from './database.js';
import {
  deleteConversation as deleteConversationFromDb,
  getConversation,
  appendMessages as appendMessagesInDb,
} from './tables/conversations.js';
import { CACHE_TTL } from './tables/market-cache.js';

// re-exports
export { openDatabase, type Database };
export { addMemory, addMemoryWithEmbedding, getMemory, deleteMemory } from './tables/memories.js';
export { CACHE_TTL };
export { type EmbeddingProvider } from './embeddings/provider.js';
export { createEmbeddingProvider } from './embeddings/provider.js';
export { assertEmbeddingDimension } from './embeddings/registry.js';
export { mergeHybridResults, type ChunkSearchResult } from './search/hybrid.js';
export { searchFts } from './search/fts.js';
export { searchVector } from './search/vector.js';

export { getCachedData, setCachedData, getStaleCachedData } from './tables/market-cache.js';
export {
  addTransaction,
  getTransaction,
  listTransactions,
  updateTransaction,
  deleteTransaction,
  replaceAllHoldings,
  type Transaction,
} from './transactions.js';
export {
  addAgentRun,
  getAgentRun,
  listAgentRuns,
  linkMemoryToAgentRun,
  type AddAgentRunInput,
} from './agent-runs.js';
export {
  addSchedule,
  getSchedule,
  listSchedules,
  updateSchedule,
  deleteSchedule,
  findDueSchedules,
  markScheduleRun,
} from './schedules.js';
export { addSpan } from './spans.js';
export { addAccessLog, purgeAccessLog, type AccessLogEntry } from './access-log.js';
export { type Reranker } from './rerank/index.js';
export { LocalReranker, type LocalRerankerOptions } from './rerank/local.js';
export { MockReranker, createRerankerWithFallback } from './rerank/mock.js';

export interface StorageOptions {
  dbPath: string;
  enableWAL?: boolean;
}

/**
 * createStorage 반환 타입 — StorageAdapter 계약 + skills-finance가 필요로 하는
 * 원시 DatabaseSync 핸들을 함께 노출한다.
 */
export interface FinClawStorage extends StorageAdapter {
  readonly db: Database['db'];
  /** Phase 29 C7: vec0 의 embedding 차원 (main.ts 의 assertEmbeddingDimension 검사용) */
  readonly vectorDimension: number;
}

export function createStorage(options: StorageOptions): FinClawStorage {
  const database = openDatabase({
    path: options.dbPath,
    enableWAL: options.enableWAL,
  });

  return {
    get db(): Database['db'] {
      return database.db;
    },
    get vectorDimension(): number {
      return database.vectorDimension;
    },

    async initialize(): Promise<void> {
      // DB already initialized in openDatabase — no-op
    },

    async close(): Promise<void> {
      database.close();
    },

    async appendMessages(payload): Promise<void> {
      appendMessagesInDb(database.db, payload);
    },

    async getConversation(sessionKey: SessionKey): Promise<ConversationRecord | null> {
      return getConversation(database.db, sessionKey);
    },

    async deleteConversation(sessionKey: SessionKey): Promise<boolean> {
      return deleteConversationFromDb(database.db, sessionKey);
    },
  };
}
