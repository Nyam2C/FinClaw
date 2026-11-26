// packages/skills-finance/test/toss/client.live.test.ts
// 실키 스모크 (`pnpm test:live`). 레포 루트 `.env` 의 TOSS_CLIENT_ID/SECRET 을 직접 읽는다 — 없으면 건너뜀.
// GET 만 보낸다. 계좌 응답은 값이 아니라 필드 존재만 확인한다 (출력 금지).
import { existsSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TossClient } from '../../src/toss/client.js';

function readDotEnv(key: string): string | undefined {
  const path = join(process.cwd(), '.env');
  if (!existsSync(path)) {
    return undefined;
  }
  const line = readFileSync(path, 'utf8')
    .split('\n')
    .find((l) => l.startsWith(`${key}=`));
  return line?.slice(key.length + 1).trim() || undefined;
}

const clientId = readDotEnv('TOSS_CLIENT_ID');
const clientSecret = readDotEnv('TOSS_CLIENT_SECRET');

describe.skipIf(!clientId || !clientSecret)('TossClient (live, read-only)', () => {
  // 테스트 격리가 HOME 을 임시 폴더로 바꾸므로, 서버와 같은 토큰 파일을 쓰도록 실제 홈을 지정한다.
  const toss = new TossClient({
    clientId: clientId as string,
    clientSecret: clientSecret as string,
    tokenPath: join(userInfo().homedir, '.finclaw', 'toss-token.json'),
  });

  it('시세 · 종목 정보 · 일봉을 읽는다', async () => {
    const prices = await toss.get<{ symbol: string; lastPrice: string; currency: string }[]>(
      '/api/v1/prices',
      { symbols: '005930,AAPL' },
    );
    expect(prices.map((p) => p.symbol).toSorted()).toEqual(['005930', 'AAPL']);
    expect(Number(prices[0].lastPrice)).toBeGreaterThan(0);

    const stocks = await toss.get<{ symbol: string; name: string }[]>('/api/v1/stocks', {
      symbols: '005930',
    });
    expect(stocks[0].name).toBe('삼성전자');

    const candles = await toss.get<{ candles: { closePrice: string }[] }>('/api/v1/candles', {
      symbol: '005930',
      interval: '1d',
      count: 2,
    });
    expect(candles.candles).toHaveLength(2);
  });

  it('계좌 헤더를 붙여 보유 종목을 읽는다', async () => {
    const holdings = await toss.get<{ items: unknown[]; marketValue: unknown }>(
      '/api/v1/holdings',
      {},
      { account: true },
    );
    expect(Array.isArray(holdings.items)).toBe(true);
    expect(holdings.marketValue).toBeTypeOf('object');
  });
});
