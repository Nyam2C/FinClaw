// packages/server/src/agent-runtime/prepare-turn.test.ts
// Phase 46 M2: 컨텍스트 블록 형식·빈 섹션 생략·oneShot·recap 상한.
import type { FinClawLogger } from '@finclaw/infra';
import { createSessionKey, type ConversationMessage } from '@finclaw/types';
import { describe, expect, it, vi } from 'vitest';
import type { MemoryCaptureService } from '../auto-reply/stages/memory-capture.js';
import type {
  MemoryRetrievalService,
  RetrievalResult,
} from '../auto-reply/stages/memory-retrieval.js';
import { composePrompt, prepareTurn } from './prepare-turn.js';

const NOW = Date.UTC(2026, 10, 26, 1, 0, 0); // = 2026-11-26 10:00 KST
const SK = createSessionKey('s1');
const TIME_LINE = '현재 시각: 2026-11-26T10:00:00+09:00 (Asia/Seoul)';

function makeLogger(): FinClawLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    flush: vi.fn(),
  } as unknown as FinClawLogger;
}

function retrievalOf(snippets: RetrievalResult['snippets']): MemoryRetrievalService {
  const result: RetrievalResult = {
    snippets,
    transactions: [],
    mode: 'fts-only',
    auditLog: {
      event: 'memory.injected',
      sessionKey: 's1',
      userQuery: 'q',
      memoryIds: snippets.map((s) => s.id),
      rawScores: [],
      adjustedScores: [],
      mode: 'fts-only',
      transactionSymbols: [],
      timestamp: NOW,
    },
  };
  return { searchRelevant: vi.fn().mockResolvedValue(result) };
}

const SNIPPET = {
  id: 'abcdef12-0000-4000-8000-000000000000',
  content: '나는 배당주를 선호한다',
  type: 'preference' as const,
  createdAt: Date.UTC(2026, 10, 25),
  rawScore: 0.8,
  adjustedScore: 0.79,
  daysOld: 1,
};

describe('prepareTurn', () => {
  it('chat: <context> = 시각 + formatBackgroundSection 그대로', async () => {
    const p = await prepareTurn({
      input: '내 투자 선호?',
      sessionKey: SK,
      mode: 'chat',
      now: NOW,
      retrieval: retrievalOf([SNIPPET]),
      logger: makeLogger(),
    });
    expect(p.context).toBe(
      [
        '<context>',
        TIME_LINE,
        '## 사용자 배경지식 (자동 주입)',
        '- [preference] 나는 배당주를 선호한다 (2026-11-25 저장) [mem:abcdef]',
        '</context>',
      ].join('\n'),
    );
    expect(p.snippets).toHaveLength(1);
  });

  it('회상이 비면 섹션을 생략한다', async () => {
    const p = await prepareTurn({
      input: 'q',
      sessionKey: SK,
      mode: 'chat',
      now: NOW,
      retrieval: retrievalOf([]),
      logger: makeLogger(),
    });
    expect(p.context).toBe(`<context>\n${TIME_LINE}\n</context>`);
  });

  it('oneShot: 시각만, capture·retrieval 미호출', async () => {
    const capture: MemoryCaptureService = { capture: vi.fn() };
    const retrieval = retrievalOf([SNIPPET]);
    const p = await prepareTurn({
      input: '기억해: 나는 성장주를 싫어한다',
      sessionKey: SK,
      mode: 'oneShot',
      now: NOW,
      capture,
      retrieval,
      logger: makeLogger(),
    });
    expect(p.context).toBe(`<context>\n${TIME_LINE}\n</context>`);
    expect(capture.capture).not.toHaveBeenCalled();
    expect(retrieval.searchRelevant).not.toHaveBeenCalled();
  });

  it('capture 를 retrieval 보다 먼저 호출하고 결과를 돌려준다', async () => {
    const captured = {
      memoryId: 'm-1',
      type: 'fact' as const,
      content: '나는 자두',
      duplicate: false,
    };
    const capture: MemoryCaptureService = { capture: vi.fn().mockResolvedValue(captured) };
    const retrieval = retrievalOf([]);
    const p = await prepareTurn({
      input: '기억해: 나는 자두',
      sessionKey: SK,
      mode: 'chat',
      now: NOW,
      capture,
      retrieval,
      logger: makeLogger(),
    });
    expect(p.captured).toEqual(captured);
    expect(vi.mocked(capture.capture).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(retrieval.searchRelevant).mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('retrieval 실패는 삼키고 warn(memory.retrieval.stage_error)', async () => {
    const logger = makeLogger();
    const p = await prepareTurn({
      input: 'q',
      sessionKey: SK,
      mode: 'chat',
      now: NOW,
      retrieval: { searchRelevant: vi.fn().mockRejectedValue(new Error('boom')) },
      logger,
    });
    expect(p.context).toBe(`<context>\n${TIME_LINE}\n</context>`);
    expect(logger.warn).toHaveBeenCalledWith(
      'memory retrieval failed (suppressed)',
      expect.objectContaining({ event: 'memory.retrieval.stage_error' }),
    );
  });
});

describe('composePrompt', () => {
  const CTX = `<context>\n${TIME_LINE}\n</context>`;
  const msg = (role: 'user' | 'assistant', content: string): ConversationMessage => ({
    role,
    content,
  });

  it('recap 이 없으면 <context> 로 시작하고 원문으로 끝난다', () => {
    expect(composePrompt(CTX, [], '질문')).toBe(`${CTX}\n\n질문`);
  });

  it('recap: 최근 6 메시지, 메시지당 500자, 역할 라벨', () => {
    const history = Array.from({ length: 8 }, (_, i) =>
      msg(i % 2 === 0 ? 'user' : 'assistant', `${i}`.padEnd(600, 'x')),
    );
    const prompt = composePrompt(CTX, history, '질문');
    const block = prompt.slice(0, prompt.indexOf('</recent_conversation>'));
    const lines = block.split('\n').slice(1, -1); // 머리 태그·끝 빈 줄 제외
    expect(lines).toHaveLength(6);
    expect(lines[0]?.startsWith('사용자: 2')).toBe(true);
    expect(lines[1]?.startsWith('FinClaw: 3')).toBe(true);
    expect(lines[0]?.length).toBe('사용자: '.length + 500);
    expect(prompt.endsWith(`${CTX}\n\n질문`)).toBe(true);
  });

  it('recap+context 가 6,000자를 넘으면 recap 을 오래된 것부터 버린다', () => {
    const bigContext = `<context>\n${'가'.repeat(5_000)}\n</context>`;
    const history = Array.from({ length: 6 }, (_, i) => msg('user', `${i}`.padEnd(400, 'y')));
    const prompt = composePrompt(bigContext, history, '질문');
    const recap = prompt.slice(0, prompt.indexOf(bigContext));
    expect(recap.length + bigContext.length).toBeLessThanOrEqual(6_000 + 2);
    expect(recap).not.toContain('사용자: 0');
    expect(recap).toContain('사용자: 5');
  });
});
