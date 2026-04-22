import type { AgentId, ConversationMessage, SessionKey, Timestamp } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../database.js';
import { deleteConversation, getConversation, upsertConversation } from './conversations.js';

describe('upsertConversation', () => {
  let database: Database;
  const sessionKey = 'sk-upsert' as SessionKey;
  const agentId = 'agent-1' as AgentId;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
  });

  afterEach(() => {
    database.close();
  });

  it('신규 세션에 대해 createConversation 경로로 동작한다', () => {
    const msgs: ConversationMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ];

    upsertConversation(database.db, {
      sessionKey,
      agentId,
      messages: msgs,
      updatedAt: 1_000 as Timestamp,
    });

    const record = getConversation(database.db, sessionKey);
    expect(record).not.toBeNull();
    expect(record?.messages).toHaveLength(2);
    expect(record?.messages[0].content).toBe('hi');
    expect(record?.messages[1].content).toBe('hello');
    expect(record?.updatedAt).toBe(1_000);
  });

  it('기존 세션의 메시지를 치환한다 (누적 아님)', () => {
    upsertConversation(database.db, {
      sessionKey,
      agentId,
      messages: [{ role: 'user', content: 'first' }],
      updatedAt: 1_000 as Timestamp,
    });

    upsertConversation(database.db, {
      sessionKey,
      agentId,
      messages: [
        { role: 'user', content: 'second' },
        { role: 'assistant', content: 'reply' },
      ],
      updatedAt: 2_000 as Timestamp,
    });

    const record = getConversation(database.db, sessionKey);
    expect(record?.messages).toHaveLength(2);
    expect(record?.messages[0].content).toBe('second');
    expect(record?.messages[1].content).toBe('reply');
    expect(record?.updatedAt).toBe(2_000);
  });

  it('deleteConversation은 전체 레코드를 제거한다', () => {
    upsertConversation(database.db, {
      sessionKey,
      agentId,
      messages: [{ role: 'user', content: 'x' }],
      updatedAt: 1_000 as Timestamp,
    });

    expect(deleteConversation(database.db, sessionKey)).toBe(true);
    expect(getConversation(database.db, sessionKey)).toBeNull();
  });

  it('멱등적: 동일 호출 2회 시 최종 상태가 같다', () => {
    const payload = {
      sessionKey,
      agentId,
      messages: [
        { role: 'user' as const, content: 'same' },
        { role: 'assistant' as const, content: 'also same' },
      ],
      updatedAt: 5_000 as Timestamp,
    };

    upsertConversation(database.db, payload);
    upsertConversation(database.db, payload);

    const record = getConversation(database.db, sessionKey);
    expect(record?.messages).toHaveLength(2);
  });
});
