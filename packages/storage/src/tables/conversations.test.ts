import type { AgentId, ConversationMessage, SessionKey, Timestamp } from '@finclaw/types';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type Database } from '../database.js';
import { appendMessages, deleteConversation, getConversation } from './conversations.js';

describe('appendMessages', () => {
  let database: Database;
  const sessionKey = 'sk-append' as SessionKey;
  const agentId = 'agent-1' as AgentId;
  const append = (
    messages: ConversationMessage[],
    at: number,
    metadata?: Record<string, unknown>,
  ): void =>
    appendMessages(database.db, { sessionKey, agentId, messages, at: at as Timestamp, metadata });

  beforeEach(() => {
    database = openDatabase({ path: ':memory:' });
  });

  afterEach(() => {
    database.close();
  });

  it('없는 대화는 만들고, 있는 대화에는 덧붙인다 (기존 행 유지)', () => {
    append([{ role: 'user', content: 'hi' }], 1_000);
    append([{ role: 'assistant', content: 'hello' }], 2_000);

    const record = getConversation(database.db, sessionKey);
    expect(record?.messages.map((m) => m.content)).toEqual(['hi', 'hello']);
    expect(record?.createdAt).toBe(1_000);
    expect(record?.updatedAt).toBe(2_000);
  });

  it('같은 시각에 넣은 행도 넣은 순서대로 읽힌다', () => {
    append(
      [
        { role: 'system', content: '<context>' },
        { role: 'user', content: 'q' },
      ],
      5_000,
    );
    append([{ role: 'assistant', content: 'a' }], 5_000);
    append([{ role: 'tool', content: [] }], 5_000);

    const record = getConversation(database.db, sessionKey);
    expect(record?.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool']);
  });

  it('블록 배열은 JSON 으로 저장하고 그대로 돌려준다 (모르는 type 포함)', () => {
    const blocks = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text: '삼성전자 현재가는' },
      { type: 'tool_use', id: 'tu_1', name: 'get_quote', input: { symbols: ['005930'] } },
    ] as unknown as ConversationMessage['content'];
    append([{ role: 'assistant', content: blocks }], 1_000);

    expect(getConversation(database.db, sessionKey)?.messages[0].content).toEqual(blocks);
  });

  it('블록으로 푸는 것은 assistant·tool 행뿐이다 — 사용자가 친 `[...]` 는 문자열 그대로', () => {
    append(
      [
        { role: 'user', content: '["삼성전자","SK하이닉스"]' },
        { role: 'user', content: '[]' },
        { role: 'assistant', content: '[참고] 예전에 텍스트로 저장된 답' },
        { role: 'assistant', content: '[1, 2, 3]' }, // JSON 이지만 블록 배열이 아니다
      ],
      1_000,
    );
    expect(getConversation(database.db, sessionKey)?.messages.map((m) => m.content)).toEqual([
      '["삼성전자","SK하이닉스"]',
      '[]',
      '[참고] 예전에 텍스트로 저장된 답',
      '[1, 2, 3]',
    ]);
  });

  it('metadata 는 줄 때만 교체하고, 빈 messages 로 metadata 만 갱신할 수 있다', () => {
    append([{ role: 'user', content: 'hi' }], 1_000, { contextStart: 0 });
    append([{ role: 'assistant', content: 'hello' }], 2_000);
    expect(getConversation(database.db, sessionKey)?.metadata).toEqual({ contextStart: 0 });

    append([], 3_000, { contextStart: 2 });
    const record = getConversation(database.db, sessionKey);
    expect(record?.metadata).toEqual({ contextStart: 2 });
    expect(record?.messages).toHaveLength(2);
    expect(record?.updatedAt).toBe(3_000);
  });

  it('deleteConversation 은 대화와 메시지를 함께 지운다', () => {
    append([{ role: 'user', content: 'hi' }], 1_000);
    expect(deleteConversation(database.db, sessionKey)).toBe(true);
    expect(getConversation(database.db, sessionKey)).toBeNull();
    const left = database.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
    expect(left.n).toBe(0);
  });
});
