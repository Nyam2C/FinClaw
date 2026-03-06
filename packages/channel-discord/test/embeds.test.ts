import type { MarketQuote, NewsItem, Alert, Timestamp, TickerSymbol } from '@finclaw/types';
import { describe, it, expect } from 'vitest';
import {
  buildMarketEmbed,
  buildNewsEmbed,
  buildAlertEmbed,
  buildErrorEmbed,
} from '../src/embeds.js';

function makeQuote(overrides: Partial<MarketQuote> = {}): MarketQuote {
  return {
    symbol: 'AAPL' as TickerSymbol,
    price: 195.5,
    change: 3.25,
    changePercent: 1.69,
    volume: 54_000_000,
    high: 196.0,
    low: 192.0,
    open: 193.0,
    previousClose: 192.25,
    timestamp: 1708700000000 as Timestamp,
    ...overrides,
  };
}

function makeNewsItem(overrides: Partial<NewsItem> = {}): NewsItem {
  return {
    id: 'news-1',
    title: '삼성전자 실적 발표',
    url: 'https://example.com/news/1',
    source: '한국경제',
    publishedAt: 1708700000000 as Timestamp,
    ...overrides,
  };
}

function makeAlert(overrides: Partial<Alert> = {}): Alert {
  return {
    id: 'alert-1',
    symbol: 'AAPL' as TickerSymbol,
    condition: { type: 'above', value: 200 },
    enabled: true,
    createdAt: 1708700000000 as Timestamp,
    triggerCount: 0,
    cooldownMs: 300_000,
    ...overrides,
  };
}

describe('buildMarketEmbed', () => {
  it('상승 시세는 녹색(0x00c853)으로 표시한다', () => {
    const embed = buildMarketEmbed(makeQuote({ change: 3.25, changePercent: 1.69 }));
    expect(embed.data.color).toBe(0x00c853);
  });

  it('하락 시세는 빨간색(0xff1744)으로 표시한다', () => {
    const embed = buildMarketEmbed(makeQuote({ change: -2.5, changePercent: -1.3 }));
    expect(embed.data.color).toBe(0xff1744);
  });

  it('변동이 0이면 녹색으로 표시한다', () => {
    const embed = buildMarketEmbed(makeQuote({ change: 0, changePercent: 0 }));
    expect(embed.data.color).toBe(0x00c853);
  });

  it('제목에 심볼을 포함한다', () => {
    const embed = buildMarketEmbed(makeQuote({ symbol: 'TSLA' as TickerSymbol }));
    expect(embed.data.title).toContain('TSLA');
  });

  it('instrumentName이 주어지면 제목에 포함한다', () => {
    const embed = buildMarketEmbed(makeQuote(), 'Apple Inc.');
    expect(embed.data.title).toContain('Apple Inc.');
  });

  it('현재가, 변동, 거래량 필드를 포함한다', () => {
    const embed = buildMarketEmbed(makeQuote());
    const fieldNames = embed.data.fields?.map((f) => f.name) ?? [];
    expect(fieldNames).toContain('현재가');
    expect(fieldNames).toContain('변동');
    expect(fieldNames).toContain('거래량');
  });

  it('marketCap이 있으면 시가총액 필드를 추가한다', () => {
    const embed = buildMarketEmbed(makeQuote({ marketCap: 3_000_000_000_000 }));
    const fieldNames = embed.data.fields?.map((f) => f.name) ?? [];
    expect(fieldNames).toContain('시가총액');
  });

  it('marketCap이 없으면 시가총액 필드가 없다', () => {
    const embed = buildMarketEmbed(makeQuote({ marketCap: undefined }));
    const fieldNames = embed.data.fields?.map((f) => f.name) ?? [];
    expect(fieldNames).not.toContain('시가총액');
  });

  it('제목이 256자를 초과하면 잘라낸다', () => {
    const longName = 'A'.repeat(300);
    const embed = buildMarketEmbed(makeQuote(), longName);
    expect((embed.data.title ?? '').length).toBeLessThanOrEqual(256);
  });
});

describe('buildNewsEmbed', () => {
  it('제목과 URL을 설정한다', () => {
    const embed = buildNewsEmbed(makeNewsItem());
    expect(embed.data.title).toBe('삼성전자 실적 발표');
    expect(embed.data.url).toBe('https://example.com/news/1');
  });

  it('파란색(0x1565c0) 색상을 사용한다', () => {
    const embed = buildNewsEmbed(makeNewsItem());
    expect(embed.data.color).toBe(0x1565c0);
  });

  it('출처와 발행일 필드를 포함한다', () => {
    const embed = buildNewsEmbed(makeNewsItem());
    const fieldNames = embed.data.fields?.map((f) => f.name) ?? [];
    expect(fieldNames).toContain('출처');
    expect(fieldNames).toContain('발행일');
  });

  it('summary가 있으면 description을 설정한다', () => {
    const embed = buildNewsEmbed(makeNewsItem({ summary: '요약 내용' }));
    expect(embed.data.description).toBe('요약 내용');
  });

  it('summary가 없으면 description이 없다', () => {
    const embed = buildNewsEmbed(makeNewsItem({ summary: undefined }));
    expect(embed.data.description).toBeUndefined();
  });

  it('sentiment가 있으면 감성 필드를 추가한다', () => {
    const embed = buildNewsEmbed(
      makeNewsItem({
        sentiment: { score: 0.8, label: 'positive', confidence: 0.92 },
      }),
    );
    const sentimentField = embed.data.fields?.find((f) => f.name === '감성');
    expect(sentimentField).toBeDefined();
    expect(sentimentField?.value).toContain('positive');
    expect(sentimentField?.value).toContain('92%');
  });

  it('symbols가 있으면 관련 종목 필드를 추가한다', () => {
    const embed = buildNewsEmbed(
      makeNewsItem({ symbols: ['AAPL' as TickerSymbol, 'MSFT' as TickerSymbol] }),
    );
    const symbolsField = embed.data.fields?.find((f) => f.name === '관련 종목');
    expect(symbolsField).toBeDefined();
    expect(symbolsField?.value).toContain('AAPL');
    expect(symbolsField?.value).toContain('MSFT');
  });
});

describe('buildAlertEmbed', () => {
  it('활성 알림은 제목에 심볼을 포함한다', () => {
    const embed = buildAlertEmbed(makeAlert());
    expect(embed.data.title).toContain('AAPL');
  });

  it('트리거된 적 있는 알림은 주황색(0xff9800)을 사용한다', () => {
    const embed = buildAlertEmbed(makeAlert({ lastTriggeredAt: 1708700000000 as Timestamp }));
    expect(embed.data.color).toBe(0xff9800);
  });

  it('트리거된 적 없는 알림은 회색(0x9e9e9e)을 사용한다', () => {
    const embed = buildAlertEmbed(makeAlert({ lastTriggeredAt: undefined }));
    expect(embed.data.color).toBe(0x9e9e9e);
  });

  it('조건, 상태, 트리거 횟수 필드를 포함한다', () => {
    const embed = buildAlertEmbed(makeAlert());
    const fieldNames = embed.data.fields?.map((f) => f.name) ?? [];
    expect(fieldNames).toContain('조건');
    expect(fieldNames).toContain('상태');
    expect(fieldNames).toContain('트리거 횟수');
  });

  it('활성 상태를 올바르게 표시한다', () => {
    const activeEmbed = buildAlertEmbed(makeAlert({ enabled: true }));
    const disabledEmbed = buildAlertEmbed(makeAlert({ enabled: false }));
    const activeField = activeEmbed.data.fields?.find((f) => f.name === '상태');
    const disabledField = disabledEmbed.data.fields?.find((f) => f.name === '상태');
    expect(activeField?.value).toBe('활성');
    expect(disabledField?.value).toBe('비활성');
  });

  it('footer에 알림 ID를 포함한다', () => {
    const embed = buildAlertEmbed(makeAlert({ id: 'alert-xyz' }));
    expect(embed.data.footer?.text).toContain('alert-xyz');
  });

  it('condition.field가 있으면 조건에 포함한다', () => {
    const embed = buildAlertEmbed(
      makeAlert({ condition: { type: 'above', value: 200, field: 'price' } }),
    );
    const condField = embed.data.fields?.find((f) => f.name === '조건');
    expect(condField?.value).toContain('price');
  });
});

describe('buildErrorEmbed', () => {
  it('빨간색(0xff1744) 색상을 사용한다', () => {
    const embed = buildErrorEmbed('테스트 에러');
    expect(embed.data.color).toBe(0xff1744);
  });

  it('제목이 "오류 발생"이다', () => {
    const embed = buildErrorEmbed('테스트 에러');
    expect(embed.data.title).toBe('오류 발생');
  });

  it('메시지를 description에 설정한다', () => {
    const embed = buildErrorEmbed('상세 오류 메시지');
    expect(embed.data.description).toBe('상세 오류 메시지');
  });

  it('4096자 초과 메시지를 잘라낸다', () => {
    const longMsg = 'E'.repeat(5000);
    const embed = buildErrorEmbed(longMsg);
    expect((embed.data.description ?? '').length).toBeLessThanOrEqual(4096);
  });
});
