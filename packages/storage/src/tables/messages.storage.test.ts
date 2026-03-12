import type { ConversationMessage, SessionKey, AgentId, Timestamp } from '@finclaw/types';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { openDatabase, type Database } from '../database.js';
import { createConversation } from './conversations.js';
import { addMessage, getMessages, getMessageCount, deleteMessage } from './messages.js';

describe('messages CRUD', () => {
  let database: Database;
  const sessionKey = 'test-session' as SessionKey;
  const agentId = 'test-agent' as AgentId;
  const now = Date.now() as Timestamp;

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
    // Create a conversation for FK references
    createConversation(database.db, {
      sessionKey,
      agentId,
      messages: [],
      createdAt: now,
      updatedAt: now,
    });
  });

  afterEach(() => {
    database.close();
  });

  it('메시지 추가 후 conversationId로 조회', () => {
    const msg: ConversationMessage = { role: 'user', content: 'hello' };
    const id = addMessage(database.db, sessionKey as string, msg);

    expect(id).toBeTruthy();
    const messages = getMessages(database.db, sessionKey as string);
    expect(messages).toHaveLength(1);
    expect(messages[0].content).toBe('hello');
    expect(messages[0].role).toBe('user');
  });

  it('시간순 정렬 확인 (asc/desc)', () => {
    addMessage(database.db, sessionKey as string, {
      role: 'user',
      content: 'first',
    });
    addMessage(database.db, sessionKey as string, {
      role: 'assistant',
      content: 'second',
    });

    const asc = getMessages(database.db, sessionKey as string, {
      order: 'asc',
    });
    expect(asc[0].content).toBe('first');
    expect(asc[1].content).toBe('second');

    const desc = getMessages(database.db, sessionKey as string, {
      order: 'desc',
    });
    expect(desc[0].content).toBe('second');
    expect(desc[1].content).toBe('first');
  });

  it('limit/offset 페이지네이션', () => {
    for (let i = 0; i < 5; i++) {
      addMessage(database.db, sessionKey as string, {
        role: 'user',
        content: `msg-${i}`,
      });
    }

    const page1 = getMessages(database.db, sessionKey as string, {
      limit: 2,
    });
    expect(page1).toHaveLength(2);

    const page2 = getMessages(database.db, sessionKey as string, {
      limit: 2,
      offset: 2,
    });
    expect(page2).toHaveLength(2);
    expect(page2[0].content).toBe('msg-2');
  });

  it('getMessageCount 정확성', () => {
    addMessage(database.db, sessionKey as string, {
      role: 'user',
      content: 'a',
    });
    addMessage(database.db, sessionKey as string, {
      role: 'assistant',
      content: 'b',
    });

    expect(getMessageCount(database.db, sessionKey as string)).toBe(2);
  });

  it('deleteMessage 후 조회 불가', () => {
    const id = addMessage(database.db, sessionKey as string, {
      role: 'user',
      content: 'to-delete',
    });

    expect(deleteMessage(database.db, id)).toBe(true);
    expect(getMessages(database.db, sessionKey as string)).toHaveLength(0);
  });

  it('conversation 삭제 시 CASCADE 확인', () => {
    addMessage(database.db, sessionKey as string, {
      role: 'user',
      content: 'cascade-test',
    });

    database.db.prepare('DELETE FROM conversations WHERE id = ?').run(sessionKey as string);

    const messages = getMessages(database.db, sessionKey as string);
    expect(messages).toHaveLength(0);
  });

  it('tool_calls JSON 직렬화/역직렬화', () => {
    const msg: ConversationMessage = {
      role: 'assistant',
      content: [
        { type: 'text', text: 'calling tool' },
        {
          type: 'tool_use',
          id: 'tool-1',
          name: 'getQuote',
          input: { symbol: 'AAPL' },
        },
      ],
    };

    addMessage(database.db, sessionKey as string, msg);

    const messages = getMessages(database.db, sessionKey as string);
    expect(messages).toHaveLength(1);
    expect(messages[0].toolCalls).toEqual([
      { id: 'tool-1', name: 'getQuote', input: { symbol: 'AAPL' } },
    ]);
  });
});
