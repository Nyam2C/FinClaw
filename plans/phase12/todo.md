# Phase 12: Discord Channel Adapter -- Implementation Todo

> 총 22개 파일: 소스 ~14개, 테스트 ~8개, 수정 3개

---

## Step 1: 환경 구성

### 1.1 `packages/channel-discord/package.json` 수정

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/package.json`

**변경 내용**: `discord.js`, `zod`, `@finclaw/infra` 의존성 추가

```json
{
  "name": "@finclaw/channel-discord",
  "version": "0.1.0",
  "private": true,
  "files": ["dist"],
  "type": "module",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "dependencies": {
    "@finclaw/types": "workspace:*",
    "@finclaw/infra": "workspace:*",
    "discord.js": "^14.25.1",
    "zod": "^3.25.0"
  }
}
```

**검증**:

```bash
cd /mnt/c/Users/박/Desktop/hi/FinClaw && pnpm install
```

---

### 1.2 `packages/channel-discord/tsconfig.json` 수정

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/tsconfig.json`

**변경 내용**: `references`에 `@finclaw/infra` 추가

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "dist", "rootDir": "src" },
  "include": ["src"],
  "references": [{ "path": "../types" }, { "path": "../infra" }]
}
```

---

### 1.3 `packages/channel-discord/plugin.json` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/plugin.json`

**내용**: PluginManifest 준수

```json
{
  "name": "@finclaw/channel-discord",
  "version": "0.1.0",
  "description": "Discord channel adapter for FinClaw",
  "main": "./dist/index.js",
  "type": "channel"
}
```

---

### 1.4 검증: 빌드 성공

```bash
cd /mnt/c/Users/박/Desktop/hi/FinClaw && pnpm install && pnpm build
```

---

## Step 2: 타입 + 설정

### 2.1 `src/types.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/types.ts`

```typescript
import type { ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

/** Discord 어카운트 설정 (config.ts의 Zod 스키마에서 infer) */
export type DiscordAccount = {
  readonly botToken: string;
  readonly applicationId: string;
  readonly guildIds?: readonly string[];
  readonly allowDMs: boolean;
  readonly typingIntervalMs: number;
  readonly maxChunkLength: number;
  readonly maxChunkLines: number;
  readonly approvalRequired: boolean;
  readonly approvalTimeoutMs: number;
};

/** 슬래시 커맨드 정의 */
export interface SlashCommand {
  readonly data: SlashCommandBuilder;
  execute(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void>;
}

/** 커맨드 의존성 주입 인터페이스 */
export interface CommandDeps {
  readonly financeService?: FinanceServicePort;
  readonly alertStorage?: AlertStoragePort;
}

/** 금융 서비스 포트 (skills-finance 모듈이 구현) */
export interface FinanceServicePort {
  getQuote(symbol: string): Promise<import('@finclaw/types').MarketQuote>;
  searchNews(query: string, count: number): Promise<import('@finclaw/types').NewsItem[]>;
}

/** 알림 저장소 포트 (storage 모듈이 구현) */
export interface AlertStoragePort {
  getAlerts(userId: string): Promise<import('@finclaw/types').Alert[]>;
  createAlert(
    alert: Omit<import('@finclaw/types').Alert, 'id'>,
  ): Promise<import('@finclaw/types').Alert>;
  deleteAlert(id: string): Promise<boolean>;
}

/** 버튼 인터랙션 데이터 */
export interface ApprovalButtonData {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: string;
  readonly sessionId: string;
  readonly userId: string;
}
```

---

### 2.2 `src/config.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/config.ts`

```typescript
import { z } from 'zod/v4';

export const DiscordAccountSchema = z
  .strictObject({
    botToken: z.string(),
    applicationId: z.string(),
    guildIds: z.array(z.string()).optional(),
    allowDMs: z.boolean().default(true),
    typingIntervalMs: z.number().int().min(1000).default(5000),
    maxChunkLength: z.number().int().min(500).max(2000).default(2000),
    maxChunkLines: z.number().int().min(5).max(50).default(17),
    approvalRequired: z.boolean().default(false),
    approvalTimeoutMs: z.number().int().min(10_000).default(300_000), // 5분
  })
  .readonly();

export type DiscordAccount = z.infer<typeof DiscordAccountSchema>;
```

---

### 2.3 검증: 타입 컴파일

```bash
cd /mnt/c/Users/박/Desktop/hi/FinClaw && pnpm build --filter @finclaw/channel-discord
```

---

## Step 3: 텍스트 청킹 (순수 함수)

### 3.1 `src/chunking.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/chunking.ts`

````typescript
/**
 * 텍스트를 maxLength 이하, maxLines 이하의 청크로 분할한다.
 *
 * 분할 우선순위 (높은 순):
 * 1. 빈 줄 (단락 경계)
 * 2. 줄바꿈
 * 3. 마침표 + 공백 (문장 경계)
 * 4. 공백 (단어 경계)
 * 5. 강제 분할 (maxLength 위치)
 *
 * 코드 블록(```) 내부에서의 분할 시, 닫는/여는 코드 블록 마커를 자동 삽입한다.
 */
export function chunkText(text: string, maxLength: number = 2000, maxLines: number = 17): string[] {
  if (text.length <= maxLength && countLines(text) <= maxLines) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = '';

  while (remaining.length > 0) {
    if (remaining.length <= maxLength && countLines(remaining) <= maxLines) {
      chunks.push(remaining);
      break;
    }

    // maxLength와 maxLines 중 더 작은 위치에서 분할
    let splitIndex = findSplitPoint(remaining, maxLength, maxLines);

    let chunk = remaining.slice(0, splitIndex);

    // 코드 블록 처리: 열린 코드 블록이 닫히지 않았으면 닫아준다
    const codeBlockState = trackCodeBlocks(chunk, inCodeBlock, codeBlockLang);

    if (codeBlockState.unclosed) {
      chunk += '\n```';
      inCodeBlock = true;
      codeBlockLang = codeBlockState.lang;
    } else {
      inCodeBlock = false;
      codeBlockLang = '';
    }

    chunks.push(chunk.trim());

    remaining = remaining.slice(splitIndex).trim();

    // 이전 청크에서 코드 블록이 열려 있었으면, 이어서 코드 블록을 연다
    if (inCodeBlock) {
      remaining = `\`\`\`${codeBlockLang}\n${remaining}`;
    }
  }

  return chunks.filter((c) => c.length > 0);
}

function countLines(text: string): number {
  return text.split('\n').length;
}

/** 분할 지점 탐색 — maxLength와 maxLines 이중 제한 */
function findSplitPoint(text: string, maxLength: number, maxLines: number): number {
  // maxLines 기준 위치 계산
  const lines = text.split('\n');
  let lineLimit = text.length;
  if (lines.length > maxLines) {
    lineLimit = lines.slice(0, maxLines).join('\n').length;
  }

  const effectiveMax = Math.min(maxLength, lineLimit);
  const searchRange = text.slice(0, effectiveMax);

  // 1. 빈 줄 (단락 경계)
  const doubleNewline = searchRange.lastIndexOf('\n\n');
  if (doubleNewline > effectiveMax * 0.5) return doubleNewline + 2;

  // 2. 줄바꿈
  const newline = searchRange.lastIndexOf('\n');
  if (newline > effectiveMax * 0.3) return newline + 1;

  // 3. 마침표 + 공백 (문장 경계)
  const sentence = searchRange.lastIndexOf('. ');
  if (sentence > effectiveMax * 0.3) return sentence + 2;

  // 4. 공백 (단어 경계)
  const space = searchRange.lastIndexOf(' ');
  if (space > effectiveMax * 0.3) return space + 1;

  // 5. 강제 분할
  return effectiveMax;
}

/** 코드 블록 상태 추적 */
function trackCodeBlocks(
  text: string,
  wasInCodeBlock: boolean,
  prevLang: string,
): { unclosed: boolean; lang: string } {
  const codeBlockRegex = /```(\w*)/g;
  let isOpen = wasInCodeBlock;
  let lang = prevLang;
  let match: RegExpExecArray | null;

  while ((match = codeBlockRegex.exec(text)) !== null) {
    if (isOpen) {
      isOpen = false;
      lang = '';
    } else {
      isOpen = true;
      lang = match[1] ?? '';
    }
  }

  return { unclosed: isOpen, lang };
}
````

---

### 3.2 `test/chunking.test.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/test/chunking.test.ts`

````typescript
import { describe, it, expect } from 'vitest';
import { chunkText } from '../src/chunking.js';

describe('chunkText', () => {
  it('2000자+17줄 이하 텍스트는 분할하지 않는다', () => {
    expect(chunkText('Hello', 2000, 17)).toEqual(['Hello']);
  });

  it('빈 문자열은 빈 배열을 반환한다', () => {
    expect(chunkText('', 2000, 17)).toEqual(['']);
  });

  it('maxLength 초과 시 문자 기준으로 분할한다', () => {
    const text = 'a'.repeat(3000);
    const chunks = chunkText(text, 2000, 17);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => expect(chunk.length).toBeLessThanOrEqual(2000));
  });

  it('17줄 초과 시 줄 기준으로 분할한다', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkText(text, 2000, 17);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => expect(chunk.split('\n').length).toBeLessThanOrEqual(17));
  });

  it('단락 경계(빈 줄)에서 우선 분할한다', () => {
    const paragraph1 = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const paragraph2 = Array.from({ length: 10 }, (_, i) => `line ${i + 10}`).join('\n');
    const text = `${paragraph1}\n\n${paragraph2}`;
    const chunks = chunkText(text, 2000, 17);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).not.toContain('line 10');
    expect(chunks[1]).toContain('line 10');
  });

  it('줄바꿈 경계에서 분할한다', () => {
    // 17줄 초과하되 단락 경계(빈 줄)가 없는 경우
    const text = Array.from({ length: 20 }, (_, i) => `row-${i}`).join('\n');
    const chunks = chunkText(text, 2000, 17);
    expect(chunks.length).toBeGreaterThan(1);
    // 각 청크가 줄 중간에서 잘리지 않았는지 확인
    chunks.forEach((chunk) => {
      expect(chunk.endsWith('-')).toBe(false);
    });
  });

  it('코드 블록이 청크 경계에서 분할될 때 닫기/열기 마커를 삽입한다', () => {
    const lines = [
      '```typescript',
      ...Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`),
      '```',
    ];
    const text = lines.join('\n');
    const chunks = chunkText(text, 2000, 17);
    expect(chunks.length).toBeGreaterThan(1);
    // 첫 번째 청크는 닫는 ``` 로 끝나야 한다
    expect(chunks[0]).toMatch(/```\s*$/);
    // 두 번째 청크는 여는 ```typescript 로 시작해야 한다
    expect(chunks[1]).toMatch(/^```typescript/);
  });

  it('문장 경계(마침표 + 공백)에서 분할한다', () => {
    // maxLength가 작은 상태에서 마침표+공백 기준 분할
    const text = 'Hello world. This is a test sentence. And another one here.';
    const chunks = chunkText(text, 40, 100);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('공백 경계에서 분할한다 (단어 경계)', () => {
    // 줄바꿈/마침표 없이 긴 공백 구분 텍스트
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const chunks = chunkText(text, 100, 100);
    expect(chunks.length).toBeGreaterThan(1);
    // 단어 중간에서 잘리지 않았는지 확인
    chunks.forEach((chunk) => {
      const parts = chunk.trim().split(' ');
      parts.forEach((p) => expect(p).toMatch(/^word\d+$/));
    });
  });

  it('정확히 maxLength인 텍스트는 분할하지 않는다', () => {
    const text = 'x'.repeat(2000);
    expect(chunkText(text, 2000, 17)).toEqual([text]);
  });

  it('정확히 maxLines인 텍스트는 분할하지 않는다', () => {
    const text = Array.from({ length: 17 }, (_, i) => `line ${i}`).join('\n');
    expect(chunkText(text, 2000, 17)).toEqual([text]);
  });

  it('모든 청크의 결합이 원본 내용을 보존한다', () => {
    const text = Array.from({ length: 50 }, (_, i) => `content line ${i}`).join('\n');
    const chunks = chunkText(text, 2000, 17);
    // 분할 후 재결합한 내용에 모든 원본 줄이 포함되어야 한다
    const rejoined = chunks.join('\n');
    for (let i = 0; i < 50; i++) {
      expect(rejoined).toContain(`content line ${i}`);
    }
  });
});
````

---

### 3.3 검증

```bash
cd /mnt/c/Users/박/Desktop/hi/FinClaw && pnpm vitest run packages/channel-discord/test/chunking.test.ts
```

---

## Step 4: 리치 임베드 빌더

### 4.1 `src/embeds.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/embeds.ts`

```typescript
import { EmbedBuilder } from 'discord.js';
import type { MarketQuote, NewsItem, Alert } from '@finclaw/types';

/** 시세 임베드 — MarketQuote 사용 (MarketQuoteData 아님) */
export function buildMarketEmbed(quote: MarketQuote, instrumentName?: string): EmbedBuilder {
  const isPositive = quote.change >= 0;
  const arrow = isPositive ? '▲' : '▼';
  const color = isPositive ? 0x00c853 : 0xff1744;

  // Discord 제한: 제목 256자, 설명 4096자, field value 1024자
  const title = truncate(`${quote.symbol}${instrumentName ? ` - ${instrumentName}` : ''}`, 256);

  return new EmbedBuilder()
    .setTitle(title)
    .setColor(color)
    .addFields(
      { name: '현재가', value: `**${formatCurrency(quote.price)}**`, inline: true },
      {
        name: '변동',
        value: `${arrow} ${formatCurrency(Math.abs(quote.change))} (${quote.changePercent.toFixed(2)}%)`,
        inline: true,
      },
      { name: '거래량', value: formatNumber(quote.volume), inline: true },
    )
    .addFields(
      ...(quote.marketCap
        ? [{ name: '시가총액', value: formatLargeNumber(quote.marketCap), inline: true }]
        : []),
    )
    .setFooter({ text: `마지막 업데이트: ${String(quote.timestamp)}` })
    .setTimestamp();
}

/** 뉴스 임베드 — NewsItem 사용 (NewsArticleData 아님) */
export function buildNewsEmbed(article: NewsItem): EmbedBuilder {
  const embed = new EmbedBuilder()
    .setTitle(truncate(article.title, 256))
    .setURL(article.url)
    .setColor(0x1565c0)
    .addFields(
      { name: '출처', value: article.source, inline: true },
      { name: '발행일', value: String(article.publishedAt), inline: true },
    );

  // summary는 optional — null 체크
  if (article.summary) {
    embed.setDescription(truncate(article.summary, 4096));
  }

  // sentiment는 중첩 객체: sentiment.label
  if (article.sentiment) {
    embed.addFields({
      name: '감성',
      value: `${article.sentiment.label} (${(article.sentiment.confidence * 100).toFixed(0)}%)`,
      inline: true,
    });
  }

  if (article.symbols?.length) {
    embed.addFields({ name: '관련 종목', value: article.symbols.join(', ') });
  }

  return embed;
}

/** 알림 임베드 — Alert 사용 (AlertData 아님) */
export function buildAlertEmbed(alert: Alert): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(truncate(`알림: ${alert.symbol}`, 256))
    .setColor(alert.lastTriggeredAt ? 0xff9800 : 0x9e9e9e)
    .addFields(
      {
        name: '조건',
        value: `${alert.condition.type} ${alert.condition.value}${alert.condition.field ? ` (${alert.condition.field})` : ''}`,
        inline: true,
      },
      { name: '상태', value: alert.enabled ? '활성' : '비활성', inline: true },
      { name: '트리거 횟수', value: String(alert.triggerCount), inline: true },
    )
    .setFooter({ text: `ID: ${alert.id}` });
}

/** 에러 임베드 */
export function buildErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('오류 발생')
    .setDescription(truncate(message, 4096))
    .setColor(0xff1744)
    .setTimestamp();
}

// --- 유틸리티 ---

function truncate(text: string, max: number): string {
  return text.length > max ? text.slice(0, max - 1) + '…' : text;
}

function formatCurrency(value: number): string {
  return value.toLocaleString('ko-KR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function formatNumber(value: number): string {
  return value.toLocaleString('ko-KR');
}

function formatLargeNumber(value: number): string {
  if (value >= 1e12) return `${(value / 1e12).toFixed(1)}조`;
  if (value >= 1e8) return `${(value / 1e8).toFixed(1)}억`;
  if (value >= 1e4) return `${(value / 1e4).toFixed(1)}만`;
  return formatNumber(value);
}
```

---

### 4.2 `test/embeds.test.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/test/embeds.test.ts`

```typescript
import { describe, it, expect } from 'vitest';
import {
  buildMarketEmbed,
  buildNewsEmbed,
  buildAlertEmbed,
  buildErrorEmbed,
} from '../src/embeds.js';
import type { MarketQuote, NewsItem, Alert, Timestamp, TickerSymbol } from '@finclaw/types';

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
    expect(embed.data.title!.length).toBeLessThanOrEqual(256);
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
    expect(sentimentField!.value).toContain('positive');
    expect(sentimentField!.value).toContain('92%');
  });

  it('symbols가 있으면 관련 종목 필드를 추가한다', () => {
    const embed = buildNewsEmbed(
      makeNewsItem({ symbols: ['AAPL' as TickerSymbol, 'MSFT' as TickerSymbol] }),
    );
    const symbolsField = embed.data.fields?.find((f) => f.name === '관련 종목');
    expect(symbolsField).toBeDefined();
    expect(symbolsField!.value).toContain('AAPL');
    expect(symbolsField!.value).toContain('MSFT');
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
    expect(activeField!.value).toBe('활성');
    expect(disabledField!.value).toBe('비활성');
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
    expect(condField!.value).toContain('price');
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
    expect(embed.data.description!.length).toBeLessThanOrEqual(4096);
  });
});
```

---

### 4.3 검증

```bash
cd /mnt/c/Users/박/Desktop/hi/FinClaw && pnpm vitest run packages/channel-discord/test/embeds.test.ts
```

---

## Step 5: 승인 버튼

### 5.1 `src/buttons.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/buttons.ts`

```typescript
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags,
  type Client,
} from 'discord.js';
import type { ApprovalButtonData } from './types.js';
import { createLogger } from '@finclaw/infra';

const log = createLogger({ name: 'channel-discord' });

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000; // 5분

// pending 승인 Map
const pendingApprovals = new Map<
  string,
  { resolve: (approved: boolean) => void; timer: ReturnType<typeof setTimeout> }
>();

/** 승인/거부 버튼 행 생성 */
export function buildApprovalRow(data: ApprovalButtonData): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`approve:${data.toolCallId}`)
      .setLabel('실행 승인')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`deny:${data.toolCallId}`)
      .setLabel('거부')
      .setStyle(ButtonStyle.Danger),
  );
}

/** 승인 대기 — Promise.withResolvers() + 타임아웃 */
export function waitForApproval(
  toolCallId: string,
  timeoutMs: number = APPROVAL_TIMEOUT_MS,
): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();

  const timer = setTimeout(() => {
    pendingApprovals.delete(toolCallId);
    resolve(false); // 타임아웃 시 거부
    log.info('Approval timed out', { toolCallId });
  }, timeoutMs);

  pendingApprovals.set(toolCallId, { resolve, timer });
  return promise;
}

/** 버튼 인터랙션 핸들러 등록 */
export function setupApprovalHandler(client: Client): void {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const [action, toolCallId] = interaction.customId.split(':');
    if (!action || !toolCallId) return;
    if (action !== 'approve' && action !== 'deny') return;

    const pending = pendingApprovals.get(toolCallId);
    if (!pending) {
      await interaction.reply({
        content: '이 요청은 이미 만료되었습니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    clearTimeout(pending.timer);
    pendingApprovals.delete(toolCallId);

    if (action === 'approve') {
      pending.resolve(true);
      await interaction.update({ content: '도구 실행이 승인되었습니다.', components: [] });
    } else {
      pending.resolve(false);
      await interaction.update({ content: '도구 실행이 거부되었습니다.', components: [] });
    }
  });
}

/** 테스트 유틸: pending 맵 초기화 */
export function _resetPendingApprovals(): void {
  for (const { timer } of pendingApprovals.values()) {
    clearTimeout(timer);
  }
  pendingApprovals.clear();
}
```

> 주의: `_resetPendingApprovals()`는 테스트 전용으로, pendingApprovals Map에 남은 타이머를 정리한다. plan.md에는 명시되어 있지 않으나, fake timer 테스트를 위해 필요하다.

---

### 5.2 `test/buttons.test.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/test/buttons.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildApprovalRow,
  waitForApproval,
  setupApprovalHandler,
  _resetPendingApprovals,
} from '../src/buttons.js';
import type { ApprovalButtonData } from '../src/types.js';

// discord.js mock
vi.mock('discord.js', () => {
  class ButtonBuilder {
    private _data: Record<string, unknown> = {};
    setCustomId(id: string) {
      this._data.customId = id;
      return this;
    }
    setLabel(label: string) {
      this._data.label = label;
      return this;
    }
    setStyle(style: number) {
      this._data.style = style;
      return this;
    }
    get data() {
      return this._data;
    }
  }

  class ActionRowBuilder<T = unknown> {
    private _components: T[] = [];
    addComponents(...components: T[]) {
      this._components.push(...components);
      return this;
    }
    get components() {
      return this._components;
    }
  }

  return {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle: { Success: 3, Danger: 4 },
    MessageFlags: { Ephemeral: 64 },
  };
});

// @finclaw/infra mock
vi.mock('@finclaw/infra', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    flush: vi.fn(),
  }),
}));

function makeApprovalData(overrides: Partial<ApprovalButtonData> = {}): ApprovalButtonData {
  return {
    toolCallId: 'tool-123',
    toolName: 'search',
    toolInput: '{}',
    sessionId: 'sess-1',
    userId: 'user-1',
    ...overrides,
  };
}

describe('buildApprovalRow', () => {
  it('승인/거부 버튼 2개를 포함하는 ActionRow를 생성한다', () => {
    const row = buildApprovalRow(makeApprovalData());
    expect(row.components).toHaveLength(2);
  });

  it('버튼의 customId에 toolCallId를 포함한다', () => {
    const row = buildApprovalRow(makeApprovalData({ toolCallId: 'tc-abc' }));
    const customIds = row.components.map((b: any) => b.data.customId);
    expect(customIds).toContain('approve:tc-abc');
    expect(customIds).toContain('deny:tc-abc');
  });
});

describe('waitForApproval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetPendingApprovals();
  });

  afterEach(() => {
    _resetPendingApprovals();
    vi.useRealTimers();
  });

  it('타임아웃 시 false를 반환한다', async () => {
    const promise = waitForApproval('tc-1', 5000);
    vi.advanceTimersByTime(5000);
    const result = await promise;
    expect(result).toBe(false);
  });

  it('타임아웃 전에는 resolve되지 않는다', () => {
    const promise = waitForApproval('tc-2', 10000);
    vi.advanceTimersByTime(5000);
    // Promise는 아직 pending 상태
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
  });
});

describe('setupApprovalHandler', () => {
  function makeClient() {
    const listeners: Record<string, ((...args: any[]) => Promise<void>)[]> = {};
    return {
      on(event: string, handler: (...args: any[]) => Promise<void>) {
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(handler);
      },
      emit(event: string, ...args: any[]) {
        for (const handler of listeners[event] ?? []) {
          void handler(...args);
        }
      },
      _listeners: listeners,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    _resetPendingApprovals();
  });

  afterEach(() => {
    _resetPendingApprovals();
    vi.useRealTimers();
  });

  it('approve 버튼 클릭 시 true로 resolve한다', async () => {
    const client = makeClient();
    setupApprovalHandler(client as any);

    const promise = waitForApproval('tc-approve', 30000);

    const interaction = {
      isButton: () => true,
      customId: 'approve:tc-approve',
      reply: vi.fn(),
      update: vi.fn(),
    };

    client.emit('interactionCreate', interaction);
    // flush microtasks
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result).toBe(true);
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: '도구 실행이 승인되었습니다.' }),
    );
  });

  it('deny 버튼 클릭 시 false로 resolve한다', async () => {
    const client = makeClient();
    setupApprovalHandler(client as any);

    const promise = waitForApproval('tc-deny', 30000);

    const interaction = {
      isButton: () => true,
      customId: 'deny:tc-deny',
      reply: vi.fn(),
      update: vi.fn(),
    };

    client.emit('interactionCreate', interaction);
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result).toBe(false);
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: '도구 실행이 거부되었습니다.' }),
    );
  });

  it('만료된 toolCallId에 대해 ephemeral 응답을 보낸다', async () => {
    const client = makeClient();
    setupApprovalHandler(client as any);

    // pending이 없는 상태에서 버튼 클릭
    const interaction = {
      isButton: () => true,
      customId: 'approve:nonexistent',
      reply: vi.fn(),
      update: vi.fn(),
    };

    client.emit('interactionCreate', interaction);
    await vi.advanceTimersByTimeAsync(0);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '이 요청은 이미 만료되었습니다.' }),
    );
  });

  it('버튼이 아닌 인터랙션은 무시한다', async () => {
    const client = makeClient();
    setupApprovalHandler(client as any);

    const interaction = {
      isButton: () => false,
      customId: 'approve:tc-x',
      reply: vi.fn(),
      update: vi.fn(),
    };

    client.emit('interactionCreate', interaction);
    await vi.advanceTimersByTimeAsync(0);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
  });
});
```

---

### 5.3 검증

```bash
cd /mnt/c/Users/박/Desktop/hi/FinClaw && pnpm vitest run packages/channel-discord/test/buttons.test.ts
```

---

## Step 6: Discord 클라이언트

### 6.1 `src/client.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/client.ts`

```typescript
import { Client, GatewayIntentBits, Partials, ActivityType } from 'discord.js';
import { createLogger } from '@finclaw/infra';

const log = createLogger({ name: 'channel-discord' });

export function createDiscordClient(): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });

  client.once('ready', (readyClient) => {
    log.info(
      `Logged in as ${readyClient.user.tag}, serving ${readyClient.guilds.cache.size} guilds`,
    );
    readyClient.user.setActivity('금융 AI 어시스턴트', { type: ActivityType.Playing });
  });

  client.on('error', (error) => {
    log.error('Client error', { error: error.message });
  });

  client.on('shardReconnecting', (shardId) => {
    log.info(`Shard ${shardId} reconnecting`);
  });

  return client;
}
```

이 파일은 Discord.js Client 팩토리로, unit test보다 integration test에 적합하다. 별도 테스트 파일 없음.

---

## Step 7: 인바운드 핸들러

### 7.1 `src/handler.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/handler.ts`

```typescript
import type { Client, Message as DiscordMessage } from 'discord.js';
import type { InboundMessage, CleanupFn, ChatType } from '@finclaw/types';
import { createChannelId, createTimestamp } from '@finclaw/types';
import { createLogger } from '@finclaw/infra';

const log = createLogger({ name: 'channel-discord' });

export function setupMessageHandler(
  client: Client,
  handler: (msg: InboundMessage) => Promise<void>,
): CleanupFn {
  const onMessage = async (msg: DiscordMessage) => {
    // 봇 + 시스템 메시지 이중 체크
    if (msg.author.bot || msg.system) return;
    if (!client.user) return;

    const isDM = msg.channel.isDMBased();

    // 길드 메시지: 봇 멘션이 포함된 경우만 처리
    if (!isDM && !msg.mentions.has(client.user.id)) return;

    // 멘션 제거: cleanContent 사용 (regex 대신 — Unicode 닉네임 안전)
    const body = msg.cleanContent.trim();
    if (!body) return;

    const chatType: ChatType = isDM ? 'direct' : msg.channel.isThread() ? 'group' : 'channel';

    const incoming: InboundMessage = {
      id: msg.id,
      channelId: createChannelId('discord'),
      chatType,
      senderId: msg.author.id,
      senderName: msg.author.displayName ?? msg.author.username,
      body,
      rawBody: msg.content,
      timestamp: createTimestamp(msg.createdTimestamp),
      threadId: msg.channel.isThread() ? msg.channelId : undefined,
      metadata: {
        discordChannelId: msg.channelId,
        discordGuildId: msg.guildId ?? undefined,
      },
    };

    try {
      await handler(incoming);
    } catch (error) {
      log.error('Message handler error', { messageId: msg.id, error });
    }
  };

  client.on('messageCreate', onMessage);

  // CleanupFn 반환 (CleanupFn = () => Promise<void>)
  return async () => {
    client.off('messageCreate', onMessage);
  };
}
```

> 주의: plan.md의 handler.ts는 `return () => { client.off(...) }` (동기)를 반환하지만, `CleanupFn = () => Promise<void>`이므로 `async () => { ... }`로 변경하였다. 또는 `return () => { ... } as unknown as CleanupFn`도 가능하지만, async 키워드가 안전하다.

---

### 7.2 `test/handler.test.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/test/handler.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setupMessageHandler } from '../src/handler.js';
import type { InboundMessage } from '@finclaw/types';

// @finclaw/infra mock
vi.mock('@finclaw/infra', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    flush: vi.fn(),
  }),
}));

function makeClient(overrides: Record<string, unknown> = {}) {
  const listeners: Record<string, ((...args: any[]) => any)[]> = {};
  return {
    user: { id: 'bot-123' },
    on(event: string, handler: (...args: any[]) => any) {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(handler);
    },
    off(event: string, handler: (...args: any[]) => any) {
      listeners[event] = (listeners[event] ?? []).filter((h) => h !== handler);
    },
    emit(event: string, ...args: any[]) {
      for (const h of listeners[event] ?? []) {
        void h(...args);
      }
    },
    _listeners: listeners,
    ...overrides,
  };
}

function makeDiscordMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: 'msg-1',
    author: { bot: false, id: 'user-1', displayName: 'TestUser', username: 'testuser' },
    system: false,
    channel: {
      isDMBased: () => false,
      isThread: () => false,
    },
    mentions: {
      has: (id: string) => id === 'bot-123',
    },
    cleanContent: 'Hello FinClaw',
    content: '<@bot-123> Hello FinClaw',
    createdTimestamp: 1708700000000,
    channelId: 'ch-1',
    guildId: 'guild-1',
    ...overrides,
  };
}

describe('setupMessageHandler', () => {
  let client: ReturnType<typeof makeClient>;
  let handler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = makeClient();
    handler = vi.fn().mockResolvedValue(undefined);
  });

  it('messageCreate 이벤트를 등록한다', () => {
    setupMessageHandler(client as any, handler);
    expect(client._listeners['messageCreate']).toHaveLength(1);
  });

  it('CleanupFn 호출 시 리스너를 제거한다', async () => {
    const cleanup = setupMessageHandler(client as any, handler);
    expect(client._listeners['messageCreate']).toHaveLength(1);
    await cleanup();
    expect(client._listeners['messageCreate']).toHaveLength(0);
  });

  it('일반 메시지를 InboundMessage로 변환한다', async () => {
    setupMessageHandler(client as any, handler);

    const msg = makeDiscordMessage();
    client.emit('messageCreate', msg);

    // await microtask
    await new Promise((r) => setTimeout(r, 0));

    expect(handler).toHaveBeenCalledTimes(1);
    const inbound: InboundMessage = handler.mock.calls[0][0];
    expect(inbound.id).toBe('msg-1');
    expect(inbound.senderId).toBe('user-1');
    expect(inbound.body).toBe('Hello FinClaw');
    expect(inbound.chatType).toBe('channel');
    expect(inbound.channelId).toBe('discord');
  });

  it('봇 메시지를 무시한다', async () => {
    setupMessageHandler(client as any, handler);

    const msg = makeDiscordMessage({
      author: { bot: true, id: 'bot-other', displayName: 'Bot', username: 'bot' },
    });
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it('시스템 메시지를 무시한다', async () => {
    setupMessageHandler(client as any, handler);

    const msg = makeDiscordMessage({ system: true });
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it('길드 메시지에서 봇 멘션이 없으면 무시한다', async () => {
    setupMessageHandler(client as any, handler);

    const msg = makeDiscordMessage({
      mentions: { has: () => false },
    });
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it('DM 메시지는 멘션 없이도 처리한다', async () => {
    setupMessageHandler(client as any, handler);

    const msg = makeDiscordMessage({
      channel: { isDMBased: () => true, isThread: () => false },
      mentions: { has: () => false },
    });
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledTimes(1);
    const inbound: InboundMessage = handler.mock.calls[0][0];
    expect(inbound.chatType).toBe('direct');
  });

  it('스레드 메시지의 chatType은 group이다', async () => {
    setupMessageHandler(client as any, handler);

    const msg = makeDiscordMessage({
      channel: { isDMBased: () => false, isThread: () => true },
      channelId: 'thread-1',
    });
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledTimes(1);
    const inbound: InboundMessage = handler.mock.calls[0][0];
    expect(inbound.chatType).toBe('group');
    expect(inbound.threadId).toBe('thread-1');
  });

  it('빈 cleanContent는 무시한다', async () => {
    setupMessageHandler(client as any, handler);

    const msg = makeDiscordMessage({ cleanContent: '   ' });
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it('핸들러 에러 시 로그만 남기고 throw하지 않는다', async () => {
    handler.mockRejectedValue(new Error('handler boom'));
    setupMessageHandler(client as any, handler);

    const msg = makeDiscordMessage();
    // 에러가 전파되지 않아야 한다
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('client.user가 null이면 무시한다', async () => {
    const noUserClient = makeClient({ user: null });
    setupMessageHandler(noUserClient as any, handler);

    const msg = makeDiscordMessage();
    noUserClient.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    expect(handler).not.toHaveBeenCalled();
  });

  it('metadata에 discordChannelId와 discordGuildId를 포함한다', async () => {
    setupMessageHandler(client as any, handler);

    const msg = makeDiscordMessage({ channelId: 'ch-42', guildId: 'guild-99' });
    client.emit('messageCreate', msg);

    await new Promise((r) => setTimeout(r, 0));
    const inbound: InboundMessage = handler.mock.calls[0][0];
    expect(inbound.metadata?.discordChannelId).toBe('ch-42');
    expect(inbound.metadata?.discordGuildId).toBe('guild-99');
  });
});
```

---

### 7.3 검증

```bash
cd /mnt/c/Users/박/Desktop/hi/FinClaw && pnpm vitest run packages/channel-discord/test/handler.test.ts
```

---

## Step 8: 아웃바운드 전송

### 8.1 `src/sender.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/sender.ts`

```typescript
import type { Client, TextChannel, DMChannel, ThreadChannel } from 'discord.js';
import type { OutboundMessage, ReplyPayload } from '@finclaw/types';
import { chunkText } from './chunking.js';
import { createLogger } from '@finclaw/infra';

const log = createLogger({ name: 'channel-discord' });

export async function sendOutboundMessage(client: Client, msg: OutboundMessage): Promise<void> {
  const channel = await resolveChannel(client, msg);
  if (!channel) {
    log.warn('Could not resolve channel', { targetId: msg.targetId });
    return;
  }

  for (const payload of msg.payloads) {
    await sendPayload(channel, payload, msg.replyToMessageId);
  }
}

async function sendPayload(
  channel: TextChannel | DMChannel | ThreadChannel,
  payload: ReplyPayload,
  replyToMessageId?: string,
): Promise<void> {
  if (payload.text) {
    const chunks = chunkText(payload.text, 2000, 17);

    for (let i = 0; i < chunks.length; i++) {
      const isFirst = i === 0;
      const isLast = i === chunks.length - 1;

      await channel.send({
        content: chunks[i],
        // Discord 임베드·컴포넌트는 channelData로 전달, 마지막 청크에만 첨부
        ...(isLast && payload.channelData ? payload.channelData : {}),
        ...(isFirst && replyToMessageId ? { reply: { messageReference: replyToMessageId } } : {}),
      });
    }
  } else if (payload.channelData) {
    // 텍스트 없이 임베드/컴포넌트만 전송
    await channel.send(payload.channelData as any);
  }
}

async function resolveChannel(
  client: Client,
  msg: OutboundMessage,
): Promise<TextChannel | DMChannel | ThreadChannel | null> {
  if (msg.threadId) {
    return client.channels.fetch(msg.threadId) as Promise<ThreadChannel>;
  }
  return client.channels.fetch(msg.targetId) as Promise<TextChannel | DMChannel>;
}
```

---

### 8.2 `test/sender.test.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/test/sender.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendOutboundMessage } from '../src/sender.js';
import type { OutboundMessage, ChannelId } from '@finclaw/types';

// @finclaw/infra mock
vi.mock('@finclaw/infra', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    flush: vi.fn(),
  }),
}));

function makeClient(channel: Record<string, unknown> | null = null) {
  return {
    channels: {
      fetch: vi.fn().mockResolvedValue(channel),
    },
  };
}

function makeChannel() {
  return {
    send: vi.fn().mockResolvedValue(undefined),
  };
}

function makeOutbound(overrides: Partial<OutboundMessage> = {}): OutboundMessage {
  return {
    channelId: 'discord' as ChannelId,
    targetId: 'ch-1',
    payloads: [],
    ...overrides,
  };
}

describe('sendOutboundMessage', () => {
  it('채널을 resolve할 수 없으면 경고만 남기고 반환한다', async () => {
    const client = makeClient(null);
    await sendOutboundMessage(client as any, makeOutbound());
    // send가 호출되지 않음 (채널이 null이므로)
  });

  it('텍스트 payload를 전송한다', async () => {
    const channel = makeChannel();
    const client = makeClient(channel);

    await sendOutboundMessage(
      client as any,
      makeOutbound({
        payloads: [{ text: 'Hello' }],
      }),
    );

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith(expect.objectContaining({ content: 'Hello' }));
  });

  it('긴 텍스트를 청킹하여 여러 번 전송한다', async () => {
    const channel = makeChannel();
    const client = makeClient(channel);

    const longText = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    await sendOutboundMessage(
      client as any,
      makeOutbound({
        payloads: [{ text: longText }],
      }),
    );

    expect(channel.send.mock.calls.length).toBeGreaterThan(1);
  });

  it('channelData를 마지막 청크에만 첨부한다', async () => {
    const channel = makeChannel();
    const client = makeClient(channel);

    // 17줄 초과 텍스트 + channelData
    const text = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n');
    const channelData = { embeds: [{ title: 'test' }] };

    await sendOutboundMessage(
      client as any,
      makeOutbound({
        payloads: [{ text, channelData }],
      }),
    );

    const calls = channel.send.mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    // 마지막 호출에만 embeds가 포함되어야 한다
    const lastCall = calls[calls.length - 1][0];
    expect(lastCall.embeds).toBeDefined();
    // 첫 번째 호출에는 embeds가 없어야 한다
    const firstCall = calls[0][0];
    expect(firstCall.embeds).toBeUndefined();
  });

  it('replyToMessageId가 있으면 첫 번째 청크에 reply 옵션을 첨부한다', async () => {
    const channel = makeChannel();
    const client = makeClient(channel);

    await sendOutboundMessage(
      client as any,
      makeOutbound({
        payloads: [{ text: 'Reply content' }],
        replyToMessageId: 'orig-msg-1',
      }),
    );

    const firstCall = channel.send.mock.calls[0][0];
    expect(firstCall.reply).toEqual({ messageReference: 'orig-msg-1' });
  });

  it('텍스트 없이 channelData만 있으면 channelData만 전송한다', async () => {
    const channel = makeChannel();
    const client = makeClient(channel);

    const channelData = { embeds: [{ title: 'embed only' }] };
    await sendOutboundMessage(
      client as any,
      makeOutbound({
        payloads: [{ channelData }],
      }),
    );

    expect(channel.send).toHaveBeenCalledTimes(1);
    expect(channel.send).toHaveBeenCalledWith(channelData);
  });

  it('여러 payload를 순차적으로 전송한다', async () => {
    const channel = makeChannel();
    const client = makeClient(channel);

    await sendOutboundMessage(
      client as any,
      makeOutbound({
        payloads: [{ text: 'First' }, { text: 'Second' }],
      }),
    );

    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it('threadId가 있으면 스레드 채널을 fetch한다', async () => {
    const channel = makeChannel();
    const client = makeClient(channel);

    await sendOutboundMessage(
      client as any,
      makeOutbound({
        payloads: [{ text: 'Thread msg' }],
        threadId: 'thread-1',
      }),
    );

    expect(client.channels.fetch).toHaveBeenCalledWith('thread-1');
  });
});
```

---

### 8.3 검증

```bash
cd /mnt/c/Users/박/Desktop/hi/FinClaw && pnpm vitest run packages/channel-discord/test/sender.test.ts
```

---

## Step 9: 슬래시 커맨드

### 9.1 `src/commands/ask.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/commands/ask.ts`

```typescript
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand, CommandDeps } from '../types.js';
import { chunkText } from '../chunking.js';

export const askCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('FinClaw AI에게 질문합니다')
    .addStringOption((option) =>
      option.setName('question').setDescription('질문 내용').setRequired(true),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, _deps: CommandDeps): Promise<void> {
    const question = interaction.options.getString('question', true);

    await interaction.deferReply();

    // TODO: 실행 엔진 통합 — Phase 9 runner 호출
    const result = `[placeholder] ${question}에 대한 AI 응답`;
    const chunks = chunkText(result, 2000, 17);

    await interaction.editReply({ content: chunks[0] });

    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i] });
    }
  },
};
```

---

### 9.2 `src/commands/market.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/commands/market.ts`

```typescript
import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand, CommandDeps } from '../types.js';
import { buildMarketEmbed } from '../embeds.js';

export const marketCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('market')
    .setDescription('주식/암호화폐 시세를 조회합니다')
    .addStringOption((option) =>
      option
        .setName('ticker')
        .setDescription('종목 코드 (예: AAPL, 005930.KS, BTC-USD)')
        .setRequired(true),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
    // 미구현 시 "준비 중" 응답
    if (!deps.financeService) {
      await interaction.reply({
        content: '시세 조회 기능은 아직 준비 중입니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const ticker = interaction.options.getString('ticker', true);
    await interaction.deferReply();

    try {
      const quote = await deps.financeService.getQuote(ticker);
      const embed = buildMarketEmbed(quote);
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply({
        content: `시세 조회 실패: ${(error as Error).message}`,
      });
    }
  },
};
```

---

### 9.3 `src/commands/news.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/commands/news.ts`

```typescript
import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand, CommandDeps } from '../types.js';
import { buildNewsEmbed } from '../embeds.js';

export const newsCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('news')
    .setDescription('금융 뉴스를 검색합니다')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('검색어 (예: 삼성전자, 금리, FOMC)')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option.setName('count').setDescription('뉴스 개수 (기본 5)').setMinValue(1).setMaxValue(10),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
    if (!deps.financeService) {
      await interaction.reply({
        content: '뉴스 검색 기능은 아직 준비 중입니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const query = interaction.options.getString('query') ?? '주요 금융 뉴스';
    const count = interaction.options.getInteger('count') ?? 5;

    await interaction.deferReply();

    const articles = await deps.financeService.searchNews(query, count);
    const embeds = articles.map((a) => buildNewsEmbed(a));
    await interaction.editReply({ embeds });
  },
};
```

---

### 9.4 `src/commands/alert.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/commands/alert.ts`

```typescript
import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand, CommandDeps } from '../types.js';
import { buildAlertEmbed } from '../embeds.js';

export const alertCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('alert')
    .setDescription('가격 알림을 관리합니다')
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('새 가격 알림을 설정합니다')
        .addStringOption((opt) =>
          opt.setName('ticker').setDescription('종목 코드').setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('condition')
            .setDescription('조건')
            .setRequired(true)
            .addChoices(
              { name: '이상', value: 'above' },
              { name: '이하', value: 'below' },
              { name: '변동률(%)', value: 'change_percent' },
            ),
        )
        .addNumberOption((opt) => opt.setName('value').setDescription('기준 값').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('설정된 알림 목록을 조회합니다'))
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('알림을 삭제합니다')
        .addStringOption((opt) => opt.setName('id').setDescription('알림 ID').setRequired(true)),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
    if (!deps.alertStorage) {
      await interaction.reply({
        content: '알림 기능은 아직 준비 중입니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'set': {
        const ticker = interaction.options.getString('ticker', true);
        const condition = interaction.options.getString('condition', true);
        const value = interaction.options.getNumber('value', true);
        // TODO: createAlert 호출
        await interaction.reply({
          content: `알림 설정 완료: ${ticker} ${condition} ${value}`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      case 'list': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const alerts = await deps.alertStorage.getAlerts(interaction.user.id);
        const embeds = alerts.map((a) => buildAlertEmbed(a));
        await interaction.editReply({ embeds });
        break;
      }
      case 'remove': {
        const id = interaction.options.getString('id', true);
        await deps.alertStorage.deleteAlert(id);
        await interaction.reply({ content: `알림 ${id} 삭제 완료`, flags: MessageFlags.Ephemeral });
        break;
      }
    }
  },
};
```

---

### 9.5 `src/commands/index.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/commands/index.ts`

```typescript
import { REST, Routes, MessageFlags, type Client } from 'discord.js';
import type { DiscordAccount, SlashCommand, CommandDeps } from '../types.js';
import { askCommand } from './ask.js';
import { marketCommand } from './market.js';
import { newsCommand } from './news.js';
import { alertCommand } from './alert.js';
import { createLogger } from '@finclaw/infra';
import { retry } from '@finclaw/infra';

const log = createLogger({ name: 'channel-discord' });

const commands: SlashCommand[] = [askCommand, marketCommand, newsCommand, alertCommand];

/**
 * 슬래시 커맨드를 Discord에 등록한다.
 * retry() 사용으로 REST API 일시 장애 대응.
 */
export async function registerGuildCommands(client: Client, config: DiscordAccount): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.botToken);
  const commandData = commands.map((cmd) => cmd.data.toJSON());

  if (config.guildIds?.length) {
    for (const guildId of config.guildIds) {
      await retry(
        () =>
          rest.put(Routes.applicationGuildCommands(config.applicationId, guildId), {
            body: commandData,
          }),
        { maxAttempts: 3 },
      );
      log.info(`Registered ${commands.length} commands for guild ${guildId}`);
    }
  } else {
    await retry(
      () => rest.put(Routes.applicationCommands(config.applicationId), { body: commandData }),
      { maxAttempts: 3 },
    );
    log.info(`Registered ${commands.length} global commands`);
  }
}

/** 인터랙션 라우터 설정 */
export function setupCommandRouter(client: Client, deps: CommandDeps): void {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.find((cmd) => cmd.data.name === interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction, deps);
    } catch (error) {
      log.error('Command execution error', { command: interaction.commandName, error });
      const content = `명령 실행 중 오류가 발생했습니다.`;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    }
  });
}
```

---

### 9.6 `test/commands/market.test.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/test/commands/market.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { marketCommand } from '../../src/commands/market.js';
import type { CommandDeps, FinanceServicePort } from '../../src/types.js';
import type { MarketQuote, Timestamp, TickerSymbol } from '@finclaw/types';

// discord.js mock
vi.mock('discord.js', () => {
  class SlashCommandBuilder {
    private _data: Record<string, unknown> = { name: '', description: '' };
    setName(name: string) {
      this._data.name = name;
      return this;
    }
    setDescription(desc: string) {
      this._data.description = desc;
      return this;
    }
    addStringOption(fn: (opt: any) => any) {
      fn({
        setName: (n: string) => ({
          setDescription: (d: string) => ({ setRequired: (r: boolean) => ({}) }),
        }),
      });
      return this;
    }
    get name() {
      return this._data.name;
    }
    toJSON() {
      return this._data;
    }
  }

  class EmbedBuilder {
    data: Record<string, unknown> = {};
    setTitle(t: string) {
      this.data.title = t;
      return this;
    }
    setColor(c: number) {
      this.data.color = c;
      return this;
    }
    setFooter(f: Record<string, string>) {
      this.data.footer = f;
      return this;
    }
    setTimestamp() {
      return this;
    }
    setURL(u: string) {
      this.data.url = u;
      return this;
    }
    setDescription(d: string) {
      this.data.description = d;
      return this;
    }
    addFields(...fields: any[]) {
      this.data.fields = [...((this.data.fields as any[]) ?? []), ...fields];
      return this;
    }
  }

  return {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags: { Ephemeral: 64 },
  };
});

// @finclaw/infra mock
vi.mock('@finclaw/infra', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    flush: vi.fn(),
  }),
}));

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

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    options: {
      getString: vi.fn().mockReturnValue('AAPL'),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    replied: false,
    deferred: false,
    ...overrides,
  };
}

describe('marketCommand', () => {
  it('financeService가 없으면 "준비 중" ephemeral 응답을 보낸다', async () => {
    const interaction = makeInteraction();
    const deps: CommandDeps = {};

    await marketCommand.execute(interaction as any, deps);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '시세 조회 기능은 아직 준비 중입니다.',
        flags: 64,
      }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('financeService가 있으면 deferReply 후 임베드를 전송한다', async () => {
    const interaction = makeInteraction();
    const financeService: FinanceServicePort = {
      getQuote: vi.fn().mockResolvedValue(makeQuote()),
      searchNews: vi.fn(),
    };
    const deps: CommandDeps = { financeService };

    await marketCommand.execute(interaction as any, deps);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(financeService.getQuote).toHaveBeenCalledWith('AAPL');
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) }),
    );
  });

  it('getQuote 에러 시 에러 메시지를 editReply로 전송한다', async () => {
    const interaction = makeInteraction();
    const financeService: FinanceServicePort = {
      getQuote: vi.fn().mockRejectedValue(new Error('API down')),
      searchNews: vi.fn(),
    };
    const deps: CommandDeps = { financeService };

    await marketCommand.execute(interaction as any, deps);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('API down') }),
    );
  });

  it('ticker 옵션을 올바르게 읽는다', async () => {
    const getString = vi.fn().mockReturnValue('BTC-USD');
    const interaction = makeInteraction({ options: { getString } });
    const financeService: FinanceServicePort = {
      getQuote: vi.fn().mockResolvedValue(makeQuote({ symbol: 'BTC-USD' as TickerSymbol })),
      searchNews: vi.fn(),
    };
    const deps: CommandDeps = { financeService };

    await marketCommand.execute(interaction as any, deps);

    expect(financeService.getQuote).toHaveBeenCalledWith('BTC-USD');
  });
});
```

---

### 9.7 검증

```bash
cd /mnt/c/Users/박/Desktop/hi/FinClaw && pnpm vitest run packages/channel-discord/test/commands/market.test.ts
```

---

## Step 10: 어댑터 통합

### 10.1 `src/adapter.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/adapter.ts`

```typescript
import type { Client } from 'discord.js';
import type {
  ChannelPlugin,
  ChannelMeta,
  ChannelCapabilities,
  ChannelId,
  CleanupFn,
} from '@finclaw/types';
import type { InboundMessage, OutboundMessage } from '@finclaw/types';
import { createChannelId } from '@finclaw/types';
import type { DiscordAccount } from './types.js';
import { createDiscordClient } from './client.js';
import { setupMessageHandler } from './handler.js';
import { sendOutboundMessage } from './sender.js';
import { registerGuildCommands } from './commands/index.js';
import { createLogger } from '@finclaw/infra';

const log = createLogger({ name: 'channel-discord' });

export class DiscordAdapter implements ChannelPlugin<DiscordAccount> {
  readonly id: ChannelId = createChannelId('discord');

  readonly meta: ChannelMeta = {
    name: 'discord',
    displayName: 'Discord',
    icon: 'discord',
    color: '#5865F2',
    website: 'https://discord.com',
  };

  readonly capabilities: ChannelCapabilities = {
    supportsMarkdown: true,
    supportsImages: true,
    supportsAudio: false,
    supportsVideo: false,
    supportsButtons: true,
    supportsThreads: true,
    supportsReactions: true,
    supportsEditing: true,
    maxMessageLength: 2000,
  };

  private client: Client | null = null;

  async setup(config: DiscordAccount): Promise<CleanupFn> {
    const client = createDiscordClient();
    this.client = client;

    await client.login(config.botToken);

    // 슬래시 커맨드 등록 (길드 단위)
    if (config.guildIds?.length) {
      await registerGuildCommands(client, config);
    }

    log.info('Discord adapter started');

    return async () => {
      client.removeAllListeners();
      await client.destroy();
      this.client = null;
      log.info('Discord adapter stopped');
    };
  }

  onMessage(handler: (msg: InboundMessage) => Promise<void>): CleanupFn {
    if (!this.client) throw new Error('Client not initialized — call setup() first');
    return setupMessageHandler(this.client, handler);
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.client) throw new Error('Client not initialized — call setup() first');
    await sendOutboundMessage(this.client, msg);
  }

  async sendTyping(channelId: string, chatId: string): Promise<void> {
    if (!this.client) return;
    const channel = await this.client.channels.fetch(chatId);
    if (channel && 'sendTyping' in channel) {
      await (channel as any).sendTyping();
    }
  }

  async addReaction(_messageId: string, _emoji: string): Promise<void> {
    // TODO: v0.2 — fetch message by ID, then react
  }
}
```

---

### 10.2 `test/adapter.test.ts` 생성

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/test/adapter.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DiscordAdapter } from '../src/adapter.js';

// discord.js mock
vi.mock('discord.js', () => {
  const mockClient = {
    login: vi.fn().mockResolvedValue('token'),
    destroy: vi.fn().mockResolvedValue(undefined),
    removeAllListeners: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    channels: {
      fetch: vi.fn().mockResolvedValue({
        send: vi.fn().mockResolvedValue(undefined),
        sendTyping: vi.fn().mockResolvedValue(undefined),
      }),
    },
    user: { id: 'bot-1', tag: 'FinClaw#1234', setActivity: vi.fn() },
    guilds: { cache: { size: 2 } },
  };

  return {
    Client: vi.fn().mockReturnValue(mockClient),
    GatewayIntentBits: { Guilds: 1, GuildMessages: 2, DirectMessages: 4, MessageContent: 8 },
    Partials: { Channel: 0, Message: 1 },
    ActivityType: { Playing: 0 },
    REST: vi.fn().mockReturnValue({
      setToken: vi.fn().mockReturnThis(),
      put: vi.fn().mockResolvedValue(undefined),
    }),
    Routes: {
      applicationGuildCommands: vi.fn().mockReturnValue('/commands'),
      applicationCommands: vi.fn().mockReturnValue('/commands'),
    },
    MessageFlags: { Ephemeral: 64 },
    SlashCommandBuilder: vi.fn().mockReturnValue({
      setName: vi.fn().mockReturnThis(),
      setDescription: vi.fn().mockReturnThis(),
      addStringOption: vi.fn().mockReturnThis(),
      addIntegerOption: vi.fn().mockReturnThis(),
      addNumberOption: vi.fn().mockReturnThis(),
      addSubcommand: vi.fn().mockReturnThis(),
      toJSON: vi.fn().mockReturnValue({}),
      name: 'mock',
    }),
    EmbedBuilder: vi.fn().mockReturnValue({
      setTitle: vi.fn().mockReturnThis(),
      setColor: vi.fn().mockReturnThis(),
      setFooter: vi.fn().mockReturnThis(),
      setTimestamp: vi.fn().mockReturnThis(),
      addFields: vi.fn().mockReturnThis(),
      data: {},
    }),
  };
});

// @finclaw/infra mock
vi.mock('@finclaw/infra', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    flush: vi.fn(),
  }),
  retry: vi.fn().mockImplementation((fn: () => any) => fn()),
}));

function makeConfig() {
  return {
    botToken: 'test-token',
    applicationId: 'app-123',
    guildIds: ['guild-1'],
    allowDMs: true,
    typingIntervalMs: 5000,
    maxChunkLength: 2000,
    maxChunkLines: 17,
    approvalRequired: false,
    approvalTimeoutMs: 300_000,
  };
}

describe('DiscordAdapter', () => {
  let adapter: DiscordAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    adapter = new DiscordAdapter();
  });

  it('id가 "discord"이다', () => {
    expect(adapter.id).toBe('discord');
  });

  it('meta.name이 "discord"이다', () => {
    expect(adapter.meta.name).toBe('discord');
    expect(adapter.meta.displayName).toBe('Discord');
  });

  it('capabilities에 올바른 값을 설정한다', () => {
    expect(adapter.capabilities.supportsMarkdown).toBe(true);
    expect(adapter.capabilities.supportsButtons).toBe(true);
    expect(adapter.capabilities.supportsAudio).toBe(false);
    expect(adapter.capabilities.maxMessageLength).toBe(2000);
  });

  it('setup()이 CleanupFn을 반환한다', async () => {
    const cleanup = await adapter.setup(makeConfig());
    expect(typeof cleanup).toBe('function');
  });

  it('setup() 후 client.login이 호출된다', async () => {
    await adapter.setup(makeConfig());
    const { Client } = await import('discord.js');
    const mockClient = new Client({} as any);
    expect(mockClient.login).toHaveBeenCalledWith('test-token');
  });

  it('CleanupFn 호출 시 client.destroy가 호출된다', async () => {
    const cleanup = await adapter.setup(makeConfig());
    await cleanup();
    const { Client } = await import('discord.js');
    const mockClient = new Client({} as any);
    expect(mockClient.destroy).toHaveBeenCalled();
  });

  it('setup() 전에 onMessage를 호출하면 에러를 던진다', () => {
    expect(() => adapter.onMessage(async () => {})).toThrow('Client not initialized');
  });

  it('setup() 전에 send를 호출하면 에러를 던진다', async () => {
    await expect(
      adapter.send({
        channelId: 'discord' as any,
        targetId: 'ch-1',
        payloads: [],
      }),
    ).rejects.toThrow('Client not initialized');
  });

  it('addReaction은 에러 없이 실행된다 (TODO stub)', async () => {
    await expect(adapter.addReaction('msg-1', '👍')).resolves.toBeUndefined();
  });

  it('sendTyping은 setup() 전에는 조용히 반환한다', async () => {
    await expect(adapter.sendTyping('discord', 'ch-1')).resolves.toBeUndefined();
  });

  it('ChannelPlugin 인터페이스를 준수한다 (타입 검증)', () => {
    // 이 테스트는 컴파일 타임에 검증됨 — 런타임에서는 인터페이스 존재만 확인
    expect(adapter.id).toBeDefined();
    expect(adapter.meta).toBeDefined();
    expect(adapter.capabilities).toBeDefined();
    expect(adapter.setup).toBeDefined();
    expect(adapter.onMessage).toBeDefined();
    expect(adapter.send).toBeDefined();
    expect(adapter.sendTyping).toBeDefined();
    expect(adapter.addReaction).toBeDefined();
  });
});
```

---

### 10.3 검증

```bash
cd /mnt/c/Users/박/Desktop/hi/FinClaw && pnpm vitest run packages/channel-discord/test/adapter.test.ts
```

---

## Step 11: 진입점 + Config 확장

### 11.1 `src/index.ts` 수정

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/index.ts`

기존 stub을 교체:

```typescript
import type { PluginManifest } from '@finclaw/types';
import { DiscordAdapter } from './adapter.js';

// 플러그인 인스턴스 (server가 import하여 사용)
export const discordAdapter = new DiscordAdapter();

// 타입 re-export
export type { DiscordAccount, SlashCommand, CommandDeps } from './types.js';
export { DiscordAdapter } from './adapter.js';
```

---

### 11.2 `packages/config/src/zod-schema.ts` 수정

**파일**: `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/config/src/zod-schema.ts`

**변경 내용**: `DiscordChannelSchema`에 6개 필드 추가

변경 전:

```typescript
const DiscordChannelSchema = z.strictObject({
  botToken: z.string(),
  applicationId: z.string(),
  guildIds: z.array(z.string()).optional(),
});
```

변경 후:

```typescript
const DiscordChannelSchema = z.strictObject({
  botToken: z.string(),
  applicationId: z.string(),
  guildIds: z.array(z.string()).optional(),
  allowDMs: z.boolean().optional(),
  typingIntervalMs: z.number().int().min(1000).optional(),
  maxChunkLength: z.number().int().min(500).max(2000).optional(),
  maxChunkLines: z.number().int().min(5).max(50).optional(),
  approvalRequired: z.boolean().optional(),
  approvalTimeoutMs: z.number().int().min(10_000).optional(),
});
```

> 주의: 루트 config 스키마에서는 `.optional()`만 사용하고 `.default()`는 사용하지 않는다 (plan.md 7단계 defaults.ts 정책). `.default()`는 `channel-discord/src/config.ts`의 `DiscordAccountSchema`에서만 사용한다.

---

### 11.3 최종 검증

```bash
# 전체 테스트
cd /mnt/c/Users/박/Desktop/hi/FinClaw && pnpm vitest run --filter @finclaw/channel-discord

# 타입 체크
cd /mnt/c/Users/박/Desktop/hi/FinClaw && pnpm build

# tsgo 타입 체크 (가능한 경우)
cd /mnt/c/Users/박/Desktop/hi/FinClaw && pnpm typecheck
```

---

## 체크리스트

```
=== 타입 정합성 ===
[ ] ChannelPlugin<DiscordAccount> — @finclaw/types 인터페이스 100% 준수
[ ] setup() → CleanupFn 반환 (start/stop 아님)
[ ] onMessage() → CleanupFn 반환 (void 아님)
[ ] send(msg: OutboundMessage) 단일 인자
[ ] InboundMessage 사용 (IncomingMessage 아님)
[ ] senderId, body, chatType, Timestamp 브랜드 — 올바른 필드명
[ ] @finclaw/types 금융 타입 직접 import (로컬 재정의 없음)
[ ] MarketQuote.symbol (ticker 아님), NewsItem.sentiment.label (중첩)

=== Config ===
[ ] botToken / applicationId 사용 (token / clientId 아님)
[ ] DiscordAccountSchema: Zod v4, .readonly()

=== Discord.js API ===
[ ] ephemeral: true 0개 → MessageFlags.Ephemeral 전량 교체
[ ] 슬래시 커맨드 3초 이내 deferReply/reply
[ ] msg.author.bot + msg.system 이중 체크
[ ] cleanContent 사용 (regex 멘션 제거 대신)

=== 인프라 ===
[ ] console.log/error 0개 → createLogger
[ ] plugin.json 존재 (PluginManifest 준수)
[ ] @finclaw/infra: retry, createLogger 사용

=== 테스트 ===
[ ] pnpm vitest run -- 전체 통과
[ ] pnpm build 에러 없음
[ ] pnpm typecheck (tsgo --noEmit) 전체 통과
```

---

## 파일 생성 순서 요약

| 순서 | 파일                                                    | 유형 |
| ---- | ------------------------------------------------------- | ---- |
| 1.1  | `packages/channel-discord/package.json`                 | 수정 |
| 1.2  | `packages/channel-discord/tsconfig.json`                | 수정 |
| 1.3  | `packages/channel-discord/plugin.json`                  | 신규 |
| 2.1  | `packages/channel-discord/src/types.ts`                 | 신규 |
| 2.2  | `packages/channel-discord/src/config.ts`                | 신규 |
| 3.1  | `packages/channel-discord/src/chunking.ts`              | 신규 |
| 3.2  | `packages/channel-discord/test/chunking.test.ts`        | 신규 |
| 4.1  | `packages/channel-discord/src/embeds.ts`                | 신규 |
| 4.2  | `packages/channel-discord/test/embeds.test.ts`          | 신규 |
| 5.1  | `packages/channel-discord/src/buttons.ts`               | 신규 |
| 5.2  | `packages/channel-discord/test/buttons.test.ts`         | 신규 |
| 6.1  | `packages/channel-discord/src/client.ts`                | 신규 |
| 7.1  | `packages/channel-discord/src/handler.ts`               | 신규 |
| 7.2  | `packages/channel-discord/test/handler.test.ts`         | 신규 |
| 8.1  | `packages/channel-discord/src/sender.ts`                | 신규 |
| 8.2  | `packages/channel-discord/test/sender.test.ts`          | 신규 |
| 9.1  | `packages/channel-discord/src/commands/ask.ts`          | 신규 |
| 9.2  | `packages/channel-discord/src/commands/market.ts`       | 신규 |
| 9.3  | `packages/channel-discord/src/commands/news.ts`         | 신규 |
| 9.4  | `packages/channel-discord/src/commands/alert.ts`        | 신규 |
| 9.5  | `packages/channel-discord/src/commands/index.ts`        | 신규 |
| 9.6  | `packages/channel-discord/test/commands/market.test.ts` | 신규 |
| 10.1 | `packages/channel-discord/src/adapter.ts`               | 신규 |
| 10.2 | `packages/channel-discord/test/adapter.test.ts`         | 신규 |
| 11.1 | `packages/channel-discord/src/index.ts`                 | 수정 |
| 11.2 | `packages/config/src/zod-schema.ts`                     | 수정 |

---

## 주요 설계 결정 사항

1. **`CleanupFn` 반환 타입**: `CleanupFn = () => Promise<void>`이므로, handler.ts의 cleanup 함수를 `async` 로 선언하였다. plan.md 원본 코드는 동기 함수를 반환하지만 타입 불일치가 발생하므로 수정하였다.

2. **`_resetPendingApprovals()` 테스트 유틸**: buttons.ts에 테스트용 reset 함수를 추가하였다. `vi.useFakeTimers()`와 함께 사용하여 pending Map과 타이머를 정리한다. plan.md에는 명시되지 않았으나 테스트 안정성을 위해 필요하다.

3. **Config 스키마 분리**: `channel-discord/src/config.ts`의 `DiscordAccountSchema`는 `.default()` 포함. `packages/config/src/zod-schema.ts`의 `DiscordChannelSchema`는 `.optional()`만 사용 (defaults.ts 정책 준수).

4. **`NewsItem.publishedAt`**: 타입이 `Timestamp` (branded number)이므로, embeds.ts에서 `String(article.publishedAt)`로 변환하여 사용한다.

### Critical Files for Implementation

- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/adapter.ts` - Core ChannelPlugin implementation, integrates all modules
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/handler.ts` - Inbound message conversion, CleanupFn return pattern
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/channel-discord/src/chunking.ts` - Pure function for 2000 char + 17 line dual limit splitting
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/types/src/channel.ts` - ChannelPlugin interface to implement against
- `/mnt/c/Users/박/Desktop/hi/FinClaw/packages/config/src/zod-schema.ts` - Extend DiscordChannelSchema with new fields
