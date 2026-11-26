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
  /**
   * 대화 조회. `range` 를 주면 일부 행만 읽는다 (트랜스크립트는 끝없이 자란다):
   * `offset` = 그 인덱스부터 끝까지, `tail` = 마지막 N개. `messageCount` 는 항상 전체 행 수다.
   */
  getConversation(sessionKey: SessionKey, range?: MessageRange): Promise<ConversationRecord | null>;
  deleteConversation(sessionKey: SessionKey): Promise<boolean>;
  initialize(): Promise<void>;
  close(): Promise<void>;
}

/** 읽을 메시지 범위 (rowid 순 인덱스). 둘 다 없으면 전체. */
export type MessageRange = { readonly offset: number } | { readonly tail: number };

/** 대화 레코드 */
export interface ConversationRecord {
  sessionKey: SessionKey;
  agentId: AgentId;
  messages: ConversationMessage[];
  /** 저장된 전체 행 수 (`messages` 가 일부일 수 있다). 저장소가 채운다. */
  messageCount?: number;
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
