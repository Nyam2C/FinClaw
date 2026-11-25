import type { ConversationMessage } from './agent.js';
import type { SessionKey, Timestamp, AgentId } from './common.js';

/** 스토리지 어댑터 인터페이스 */
export interface StorageAdapter {
  /**
   * 기존 대화가 있으면 messages/updatedAt을 교체하고, 없으면 생성한다.
   * auto-reply 파이프라인이 매 턴 이력 전체를 저장할 때 사용한다.
   */
  upsertConversation(record: ConversationRecord): Promise<void>;
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
