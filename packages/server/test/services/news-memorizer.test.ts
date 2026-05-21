// packages/server/test/services/news-memorizer.test.ts
import { openDatabase } from '@finclaw/storage';
import { describe, expect, it, vi } from 'vitest';
import { NewsMemorizer, parseSymbolSections } from '../../src/services/news-memorizer.js';

const noopLogger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never;

const OUTPUT = `## NVDA (2026-05-21)
어제 대비 5% 상승. 데이터센터 수요 강세.

## AAPL (2026-05-21)
WWDC 기대감으로 보합.`;

describe('news-memorizer', () => {
  it('parseSymbolSections 분할', () => {
    const s = parseSymbolSections(OUTPUT);
    expect(s).toHaveLength(2);
    expect(s[0]).toMatchObject({ symbol: 'NVDA', briefDate: '2026-05-21' });
  });

  it('absorb → financial memory 적재 + metadata.kind', async () => {
    const { db, close } = openDatabase({ path: ':memory:', enableWAL: false });
    const m = new NewsMemorizer({ db, logger: noopLogger }); // embeddingProvider 없음 → FTS only
    const n = await m.absorb({ agentRunId: 'run-1', output: OUTPUT });
    expect(n).toBe(2);
    const rows = db.prepare(`SELECT type, metadata FROM memories ORDER BY content`).all() as Array<{
      type: string;
      metadata: string;
    }>;
    expect(rows.every((r) => r.type === 'financial')).toBe(true);
    expect(JSON.parse(rows[0].metadata).kind).toBe('news-brief');
    close();
  });

  it('동일 content dedup', async () => {
    const { db, close } = openDatabase({ path: ':memory:', enableWAL: false });
    const m = new NewsMemorizer({ db, logger: noopLogger });
    await m.absorb({ agentRunId: 'r1', output: OUTPUT });
    await m.absorb({ agentRunId: 'r2', output: OUTPUT });
    const count = db.prepare(`SELECT COUNT(*) c FROM memories`).get() as { c: number };
    expect(count.c).toBe(2); // 중복 적재 안 됨
    close();
  });

  it('0 섹션 → skip', async () => {
    const { db, close } = openDatabase({ path: ':memory:', enableWAL: false });
    const m = new NewsMemorizer({ db, logger: noopLogger });
    const n = await m.absorb({ agentRunId: 'r', output: '뉴스 없음' });
    expect(n).toBe(0);
    close();
  });
});
