import type { ConversationMessage } from './agent.js';
import type { SessionKey, Timestamp, AgentId } from './common.js';

/** 스토리지 어댑터 인터페이스 */
export interface StorageAdapter {
  /**
   * 대화에 메시지 행을 덧붙인다 (없으면 생성). 트랜스크립트는 append-only — 기존 행은 건드리지 않는다.
   * `metadata` 를 주면 교체한다. `messages` 가 비면 metadata·시각만 갱신한다.
   */
  appendMessages(payload: {
    readonly sessionKey: SessionKey;
    readonly agentId: AgentId;
    readonly messages: readonly ConversationMessage[];
    readonly at: Timestamp;
    readonly metadata?: Record<string, unknown>;
  }): Promise<void>;
  getConversation(sessionKey: SessionKey): Promise<ConversationRecord | null>;
  deleteConversation(sessionKey: SessionKey): Promise<boolean>;
  initialize(): Promise<void>;
  close(): Promise<void>;
}

/** 대화 레코드 */
export interface ConversationRecord {
  sessionKey: SessionKey;
  agentId: AgentId;
  messages: ConversationMessage[];
  createdAt: Timestamp;
  updatedAt: Timestamp;
  metadata?: Record<string, unknown>;
}

/** 메모리 엔트리 */
export interface MemoryEntry {
  id: string;
  sessionKey: SessionKey;
  content: string;
  embedding?: number[];
  type: 'fact' | 'preference' | 'summary' | 'financial';
  createdAt: Timestamp;
  metadata?: Record<string, unknown>;
}
