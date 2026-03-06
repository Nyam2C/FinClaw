# Phase 12: Discord 채널 어댑터 (Discord Channel Adapter)

> **복잡도: L** | 소스 ~14 파일 | 테스트 ~8 파일 | 합계 ~22 파일

---

## 1. 목표

Discord를 통해 FinClaw 금융 AI 어시스턴트와 상호작용할 수 있는 채널 어댑터를 구현한다. OpenClaw의 Discord 어댑터(deep-dive/10)를 기반으로, 금융 도메인에 특화된 슬래시 커맨드와 임베드 포맷을 추가한다:

- **Discord.js v14 클라이언트**: 봇 설정, 인텐트 관리, 이벤트 핸들링
- **슬래시 커맨드**: `/ask` (일반 질의), `/market` (시세 조회), `/news` (금융 뉴스), `/alert` (알림 설정)
- **텍스트 청킹**: 2000자 + 17줄 이중 제한에 맞춘 메시지 분할 (마크다운 구조 보존)
- **실행 승인 버튼**: 도구 실행 전 사용자 확인 인터랙티브 컴포넌트 (5분 타임아웃)
- **리치 임베드**: 주가 데이터, 뉴스, 알림 등 금융 정보를 시각적으로 표현
- **메시지 핸들링**: DM, 길드 텍스트 채널, 스레드 지원
- **타이핑 인디케이터**: LLM 응답 생성 중 타이핑 표시
- **에러 핸들링 및 재연결**: 네트워크 오류 시 자동 재연결

---

## 2. OpenClaw 참조

| OpenClaw 경로                                        | 적용 패턴                                          |
| ---------------------------------------------------- | -------------------------------------------------- |
| `openclaw_review/deep-dive/10-discord-adapter.md`    | Discord.js v14 클라이언트 설정, 이벤트 핸들링 구조 |
| `openclaw_review/deep-dive/10` (slash commands 섹션) | 슬래시 커맨드 등록/업데이트 패턴, 길드 단위 배포   |
| `openclaw_review/deep-dive/10` (chunking 섹션)       | 2000자 제한 분할 알고리즘, 마크다운 경계 존중      |
| `openclaw_review/deep-dive/10` (approval 섹션)       | 인터랙티브 버튼 컴포넌트, tool 실행 승인 UI        |
| `openclaw_review/deep-dive/10` (embed 섹션)          | Discord 리치 임베드 빌더 패턴                      |
| `openclaw_review/deep-dive/10` (presence 섹션)       | 봇 상태 업데이트, 활동 표시                        |

**OpenClaw 차이점:**

- Voice channel 지원 → FinClaw v0.1에서는 제외 (텍스트 전용)
- 범용 슬래시 커맨드 → 금융 특화 커맨드 추가 (`/market`, `/news`, `/alert`)
- 범용 임베드 → 금융 데이터 전용 임베드 빌더 (주가 차트, 뉴스 카드)
- 채널 추상화: `ChannelPlugin<TAccount>` 인터페이스를 구현하여 다른 채널과 교환 가능

---

## 3. 생성할 파일

### 소스 파일 (`packages/channel-discord/src/`)

| 파일 경로                                         | 설명                                                       |
| ------------------------------------------------- | ---------------------------------------------------------- |
| `packages/channel-discord/plugin.json`            | 플러그인 매니페스트 (PluginManifest 준수)                  |
| `packages/channel-discord/vitest.config.ts`       | 테스트 설정                                                |
| `packages/channel-discord/src/index.ts`           | `register(api)` + 타입 re-export                           |
| `packages/channel-discord/src/types.ts`           | SlashCommand, ApprovalButtonData, CommandDeps, 서비스 포트 |
| `packages/channel-discord/src/config.ts`          | Zod v4 DiscordAccountSchema                                |
| `packages/channel-discord/src/adapter.ts`         | `ChannelPlugin<DiscordAccount>` 구현 (채널 추상화 계층)    |
| `packages/channel-discord/src/client.ts`          | Discord.js 클라이언트 초기화, 인텐트 설정, 이벤트 바인딩   |
| `packages/channel-discord/src/handler.ts`         | messageCreate → `InboundMessage` 변환 + `CleanupFn` 반환   |
| `packages/channel-discord/src/sender.ts`          | `OutboundMessage` → Discord REST 전송                      |
| `packages/channel-discord/src/chunking.ts`        | 2000자 + 17줄 이중 제한 (마크다운 경계 보존)               |
| `packages/channel-discord/src/embeds.ts`          | 리치 임베드 빌더 (`@finclaw/types` 금융 타입 사용)         |
| `packages/channel-discord/src/buttons.ts`         | 승인/거부 버튼 + 5분 타임아웃 + `Promise.withResolvers()`  |
| `packages/channel-discord/src/commands/index.ts`  | 슬래시 커맨드 레지스트리 + 인터랙션 라우터                 |
| `packages/channel-discord/src/commands/ask.ts`    | `/ask` 커맨드 - 일반 AI 질의                               |
| `packages/channel-discord/src/commands/market.ts` | `/market` 커맨드 - 시세 조회 (CommandDeps 주입)            |
| `packages/channel-discord/src/commands/news.ts`   | `/news` 커맨드 - 금융 뉴스                                 |
| `packages/channel-discord/src/commands/alert.ts`  | `/alert` 커맨드 - 가격 알림 설정/조회/삭제                 |

### 테스트 파일 (`packages/channel-discord/test/`)

| 파일 경로                                               | 테스트 대상                                        |
| ------------------------------------------------------- | -------------------------------------------------- |
| `packages/channel-discord/test/adapter.test.ts`         | ChannelPlugin 인터페이스 구현 (unit)               |
| `packages/channel-discord/test/handler.test.ts`         | 메시지 핸들링, DM/길드 분기, CleanupFn 반환 (unit) |
| `packages/channel-discord/test/sender.test.ts`          | OutboundMessage → Discord 전송 변환 (unit)         |
| `packages/channel-discord/test/chunking.test.ts`        | 2000자+17줄 분할, 마크다운 보존, 코드 블록 (unit)  |
| `packages/channel-discord/test/embeds.test.ts`          | 임베드 빌더 출력 검증 (MarketQuote 등) (unit)      |
| `packages/channel-discord/test/buttons.test.ts`         | 버튼 생성, 타임아웃, approve/deny 핸들링 (unit)    |
| `packages/channel-discord/test/commands/market.test.ts` | /market 커맨드 입력 파싱, 임베드 생성 (unit)       |

---

## 4. 핵심 인터페이스/타입

### ChannelPlugin 인터페이스 (`@finclaw/types/channel.ts` — 검증 완료)

Discord 어댑터는 `@finclaw/types`에 정의된 `ChannelPlugin<TAccount>` 인터페이스를 **직접 구현**한다.
자체 인터페이스를 재정의하지 않는다.

```typescript
// @finclaw/types — 실제 정의 (참조용, 수정하지 않음)
interface ChannelPlugin<TAccount = unknown> {
  id: ChannelId;
  meta: ChannelMeta;
  capabilities: ChannelCapabilities;
  setup?(config: TAccount): Promise<CleanupFn>; // start()+stop() 통합
  onMessage?(handler: (msg: InboundMessage) => Promise<void>): CleanupFn; // CleanupFn 반환
  send?(msg: OutboundMessage): Promise<void>; // 단일 인자 (target 포함)
  sendTyping?(channelId: string, chatId: string): Promise<void>;
  addReaction?(messageId: string, emoji: string): Promise<void>;
}
```

**기존 plan.md 대비 핵심 차이:**

| 항목        | 기존 plan.md                   | 실제 `@finclaw/types`                                |
| ----------- | ------------------------------ | ---------------------------------------------------- |
| 시작/종료   | `start()` / `stop()`           | `setup(config) → CleanupFn` (통합)                   |
| 메시지 전송 | `send(target, message)` 2인자  | `send(msg: OutboundMessage)` 1인자                   |
| 메시지 수신 | `onMessage(handler): void`     | `onMessage(handler): CleanupFn`                      |
| 상태 조회   | `status(): ChannelStatus`      | 없음 (별도 구현 시 내부 메서드로)                    |
| 식별자      | `name: string`, `type: string` | `id: ChannelId`, `meta: ChannelMeta`, `capabilities` |

### 메시지 타입 (`@finclaw/types/message.ts` — 검증 완료)

```typescript
// InboundMessage — 수신 메시지 (IncomingMessage 아님)
interface InboundMessage {
  id: string;
  channelId: ChannelId;
  chatType: ChatType; // 'direct' | 'group' | 'channel' (isDM 아님)
  senderId: string; // userId 아님
  senderName?: string;
  body: string; // content 아님
  rawBody?: string;
  timestamp: Timestamp; // number 아님, 브랜드 타입
  threadId?: string;
  replyToId?: string;
  media?: MediaAttachment[];
  metadata?: Record<string, unknown>;
}

// OutboundMessage — 송신 메시지 (ChannelMessage + ChannelTarget 아님)
interface OutboundMessage {
  channelId: ChannelId;
  targetId: string;
  payloads: ReplyPayload[]; // content/embeds/components 아님
  replyToMessageId?: string;
  threadId?: string;
}

// ReplyPayload — 개별 응답 단위
interface ReplyPayload {
  text?: string;
  mediaUrl?: string;
  mediaUrls?: string[];
  replyToId?: string;
  isError?: boolean;
  channelData?: Record<string, unknown>; // Discord 임베드·컴포넌트 전달
}
```

### Discord 특화 타입 (`packages/channel-discord/src/types.ts` — 신규)

```typescript
import type { ChatInputCommandInteraction, SlashCommandBuilder, MessageFlags } from 'discord.js';

/** Discord 어카운트 설정 (config.ts의 Zod 스키마에서 infer) */
export type DiscordAccount = {
  readonly botToken: string; // token 아님
  readonly applicationId: string; // clientId 아님
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

**금융 타입**: `MarketQuote`, `NewsItem`, `Alert`, `TickerSymbol` 등은 모두 `@finclaw/types`에서 직접 import한다. 로컬 재정의(`MarketQuoteData`, `NewsArticleData`, `AlertData`)는 사용하지 않는다.

---

## 5. 구현 상세

### 5.1 Discord 클라이언트 (`client.ts`)

Discord.js v14 클라이언트를 초기화하고, 필요한 인텐트와 파티셔닝을 설정한다.

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

### 5.2 ChannelPlugin 구현 (`adapter.ts`)

`ChannelPlugin<DiscordAccount>`를 구현한다. `setup(config)` → `CleanupFn` 패턴.

```typescript
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

### 5.3 메시지 핸들러 (`handler.ts`)

Discord `messageCreate` → `InboundMessage` 변환. `CleanupFn`을 반환한다.

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

  // CleanupFn 반환
  return () => {
    client.off('messageCreate', onMessage);
  };
}
```

### 5.4 아웃바운드 전송 (`sender.ts`)

`OutboundMessage` → Discord 메시지 변환. `payloads`를 순회하며 전송한다.

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

### 5.5 텍스트 청킹 (`chunking.ts`)

2000자 + 17줄 이중 제한. Discord 클라이언트에서 17줄 초과 시 "더 보기" 접기가 발생하여 UX 저하.

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

### 5.6 리치 임베드 빌더 (`embeds.ts`)

`@finclaw/types`의 금융 타입을 직접 사용한다. 로컬 재정의 없음.

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
      { name: '발행일', value: article.publishedAt, inline: true },
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

### 5.7 승인 버튼 (`buttons.ts`)

5분 타임아웃 추가. `Promise.withResolvers()` (Node.js 22+ 네이티브) 사용.

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
```

### 5.8 슬래시 커맨드 (`commands/`)

```typescript
// commands/index.ts - 커맨드 레지스트리 + 인터랙션 라우터
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

```typescript
// commands/market.ts - /market 커맨드 (CommandDeps 주입)
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

```typescript
// commands/news.ts - /news 커맨드
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

```typescript
// commands/alert.ts - /alert 커맨드 (set/list/remove)
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

```typescript
// commands/ask.ts - /ask 커맨드 (범용 AI 질의)
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

### 5.9 진입점 (`index.ts`)

```typescript
import type { PluginManifest } from '@finclaw/types';
import { DiscordAdapter } from './adapter.js';

// 플러그인 인스턴스 (server가 import하여 사용)
export const discordAdapter = new DiscordAdapter();

// 타입 re-export
export type { DiscordAccount, SlashCommand, CommandDeps } from './types.js';
export { DiscordAdapter } from './adapter.js';
```

### 5.10 Config 스키마 (`config.ts`)

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

### 데이터 흐름 다이어그램

```
Discord Server
     │
     ├── 메시지 (@FinClaw 멘션 또는 DM)
     │       │
     │       ▼
     │   ┌────────────────┐
     │   │ Message Handler │ → InboundMessage 변환 (senderId, body, chatType)
     │   │ (handler.ts)    │   CleanupFn 반환
     │   └───────┬────────┘
     │           │
     │           ▼
     │   ┌────────────────┐     ┌──────────────┐
     │   │ ChannelPlugin  │────▶│ Execution    │
     │   │ (adapter.ts)   │     │ Engine       │
     │   │ setup()→Cleanup│     │ (Phase 9)    │
     │   └───────┬────────┘     └──────┬───────┘
     │           │                     │
     │           ▼                     ▼
     │   ┌────────────────┐   ┌──────────────┐
     │   │ Sender          │   │ Tool Results │
     │   │ OutboundMessage │   └──────┬───────┘
     │   │ → payloads 순회 │          │
     │   └───────┬────────┘     ┌────┘
     │           │              ▼
     │           ▼         ┌──────────────────┐
     │   ┌──────────────┐  │ Text Chunking    │
     │   │ Discord.js   │  │ (≤2000 + ≤17줄)  │
     │   │ Send         │◀─┘                  │
     │   └──────────────┘  └──────────────────┘
     │
     ├── 슬래시 커맨드 (/market AAPL)
     │       │
     │       ▼
     │   ┌────────────────┐
     │   │ Command Router │ (CommandDeps 주입)
     │   └───────┬────────┘
     │     ┌─────┼─────┬──────┐
     │     ▼     ▼     ▼      ▼
     │   /ask  /market /news  /alert
     │     │     │      │      │
     │     ▼     ▼      ▼      ▼
     │   ┌──────────────────────────┐
     │   │ Rich Embed Builder       │
     │   │ (MarketQuote, NewsItem,  │
     │   │  Alert — @finclaw/types) │
     │   └──────────────────────────┘
     │
     └── 버튼 인터랙션 (승인/거부)
             │
             ▼
         ┌────────────────────┐
         │ Approval Handler   │ → Promise.withResolvers()
         │ 5분 타임아웃       │   pending Map 정리
         └────────────────────┘
```

---

## 6. 선행 조건

| Phase        | 구체적 산출물                                                                              | 상태     | 필요 이유                                                             |
| ------------ | ------------------------------------------------------------------------------------------ | -------- | --------------------------------------------------------------------- |
| **Phase 5**  | `packages/types/src/channel.ts` — `ChannelPlugin<T>`, `ChannelMeta`, `ChannelCapabilities` | **완성** | Discord 어댑터가 구현해야 할 채널 추상화 인터페이스                   |
| **Phase 5**  | `packages/types/src/message.ts` — `InboundMessage`, `OutboundMessage`, `ReplyPayload`      | **완성** | 메시지 변환 인터페이스                                                |
| **Phase 5**  | `packages/types/src/finance.ts` — `MarketQuote`, `NewsItem`, `Alert`                       | **완성** | 금융 임베드 빌더 타입                                                 |
| **Phase 5**  | `packages/types/src/plugin.ts` — `PluginManifest`, `PluginRegistry`                        | **완성** | 플러그인 등록 인터페이스                                              |
| **Phase 9**  | `packages/agent/` — 실행 엔진                                                              | **완성** | `/ask` 커맨드 및 메시지 핸들러가 AI 응답 생성을 위해 호출             |
| **Phase 10** | `packages/server/` — 게이트웨이 서버                                                       | **완성** | Discord 어댑터가 게이트웨이를 통해 실행 엔진과 통신 (옵션)            |
| **Phase 7**  | `packages/skills-finance/` — 금융 스킬                                                     | 미완성   | `/market`, `/news`, `/alert` — CommandDeps로 주입, 미구현 시 graceful |
| **Phase 3**  | `packages/storage/` — 저장소 모듈                                                          | 미완성   | 알림 데이터 영구 저장 — CommandDeps로 주입, 미구현 시 graceful        |

---

## 7. 수정 대상 기존 파일

| 파일                                     | 변경 내용                                                                                                                                     |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/channel-discord/package.json`  | `discord.js ^14.25.1`, `zod ^3.25.0`, `@finclaw/infra workspace:*` 추가                                                                       |
| `packages/channel-discord/tsconfig.json` | `references`에 `{ "path": "../infra" }` 추가                                                                                                  |
| `packages/config/src/zod-schema.ts`      | `DiscordChannelSchema`에 `allowDMs`, `typingIntervalMs`, `maxChunkLength`, `maxChunkLines`, `approvalRequired`, `approvalTimeoutMs` 필드 추가 |

---

## 8. `@finclaw/infra` 활용 (중복 구현 방지)

| 기능      | infra 유틸                                  | 적용 위치                              |
| --------- | ------------------------------------------- | -------------------------------------- |
| 로깅      | `createLogger({ name: 'channel-discord' })` | 전 파일 (`console.log/error` 0개)      |
| 재시도    | `retry()`, `computeBackoff()`               | 슬래시 커맨드 REST 등록                |
| 중복 방지 | `Dedupe<T>`                                 | handler.ts (메시지 이벤트 중복 가능성) |
| 에러 래핑 | `wrapError()`, `FinClawError`               | Discord API 에러 변환                  |

---

## 9. 구현 순서

```
Step 1: 환경 구성
  - plugin.json, package.json 의존성, tsconfig.json references, vitest.config.ts
  → 검증: pnpm install && pnpm build 성공

Step 2: 타입·설정 (외부 의존 없음)
  - types.ts, config.ts (Zod v4 스키마)
  → 검증: 타입 컴파일 성공

Step 3: 순수 함수 (mock 불필요)
  - chunking.ts + test/chunking.test.ts
  → 가장 먼저 테스트 가능

Step 4: 임베드 빌더
  - embeds.ts + test/embeds.test.ts

Step 5: 버튼 + 타임아웃
  - buttons.ts + test/buttons.test.ts

Step 6: 클라이언트
  - client.ts (Discord.js Client 팩토리)

Step 7: 인바운드 처리
  - handler.ts + test/handler.test.ts

Step 8: 아웃바운드 처리
  - sender.ts + test/sender.test.ts

Step 9: 슬래시 커맨드
  - commands/*.ts + test/commands/market.test.ts

Step 10: 통합 조립
  - adapter.ts + test/adapter.test.ts

Step 11: 진입점 + config 확장
  - index.ts (register 함수)
  - @finclaw/config DiscordChannelSchema 필드 추가
  → 검증: pnpm test --filter @finclaw/channel-discord
  → 검증: pnpm typecheck (tsgo --noEmit) 전체 통과
```

---

## 10. 산출물 및 검증

### 테스트 가능한 결과물

| 산출물             | 검증 방법                                                              |
| ------------------ | ---------------------------------------------------------------------- |
| ChannelPlugin 구현 | unit: setup()→CleanupFn, send(OutboundMessage), onMessage()→CleanupFn  |
| 메시지 핸들러      | unit: bot+system 이중 체크, cleanContent, InboundMessage 필드 매핑     |
| 아웃바운드 전송    | unit: payloads 순회, 청킹 적용, channelData 전달                       |
| 슬래시 커맨드 등록 | unit: REST API mock, retry, 길드/글로벌 분기                           |
| /market 커맨드     | unit: CommandDeps 주입, 미구현 시 graceful, MarketQuote 임베드         |
| /news 커맨드       | unit: CommandDeps 주입, NewsItem 임베드                                |
| /alert 커맨드      | unit: set/list/remove 서브커맨드, AlertStorage 주입                    |
| 텍스트 청킹        | unit: 2000자+17줄 분할, 마크다운 보존, 코드 블록 처리                  |
| 리치 임베드        | unit: MarketQuote/NewsItem/Alert/에러 임베드 필드 및 Discord 제한 준수 |
| 승인 버튼          | unit: 버튼 생성, 5분 타임아웃, Promise.withResolvers(), Map 정리       |

### 검증 체크리스트

```
=== 타입 정합성 ===
□ ChannelPlugin<DiscordAccount> — @finclaw/types 인터페이스 100% 준수
□ setup() → CleanupFn 반환 (start/stop 아님)
□ onMessage() → CleanupFn 반환 (void 아님)
□ send(msg: OutboundMessage) 단일 인자
□ InboundMessage 사용 (IncomingMessage 아님)
□ senderId, body, chatType, Timestamp 브랜드 — 올바른 필드명
□ @finclaw/types 금융 타입 직접 import (로컬 재정의 없음)
□ MarketQuote.symbol (ticker 아님), NewsItem.sentiment.label (중첩)

=== Config ===
□ botToken / applicationId 사용 (token / clientId 아님)
□ DiscordAccountSchema: Zod v4, .readonly()

=== Discord.js API ===
□ ephemeral: true 0개 → MessageFlags.Ephemeral 전량 교체
□ 슬래시 커맨드 3초 이내 deferReply/reply
□ msg.author.bot + msg.system 이중 체크
□ cleanContent 사용 (regex 멘션 제거 대신)

=== 인프라 ===
□ console.log/error 0개 → createLogger
□ plugin.json 존재 (PluginManifest 준수)
□ @finclaw/infra: retry, createLogger, wrapError 사용

=== 테스트 ===
□ pnpm test --filter @finclaw/channel-discord 전체 통과
□ statements ≥ 80%, branches ≥ 75%
□ pnpm build + pnpm typecheck 에러 없음
```

### 테스트 전략

Discord.js 클라이언트를 직접 테스트하기 어려우므로, 다음 전략을 사용한다:

1. **순수 함수** (chunking, embeds, config validation): mock 불필요, 직접 호출
2. **Discord.js 의존 함수** (handler, sender, commands): vi.mock으로 discord.js 모듈 mock
3. **타이머 의존** (buttons, typing): `vi.useFakeTimers()` + `vi.advanceTimersByTime()`

```typescript
// 예시: chunking 테스트 (mock 불필요)
describe('chunkText', () => {
  it('2000자+17줄 이하 텍스트는 분할하지 않는다', () => {
    expect(chunkText('Hello', 2000, 17)).toEqual(['Hello']);
  });

  it('17줄 초과 시 줄 기준으로 분할한다', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkText(text, 2000, 17);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => expect(chunk.split('\n').length).toBeLessThanOrEqual(17));
  });
});

// 예시: embeds 테스트 — @finclaw/types MarketQuote 사용
describe('buildMarketEmbed', () => {
  it('상승 시세는 녹색으로 표시한다', () => {
    const embed = buildMarketEmbed({
      symbol: 'AAPL', // ticker 아님
      price: 195.5,
      change: 3.25,
      changePercent: 1.69,
      volume: 54_000_000,
      high: 196.0,
      low: 192.0,
      open: 193.0,
      previousClose: 192.25,
      timestamp: '2026-02-23T15:30:00Z' as any,
    });
    expect(embed.data.color).toBe(0x00c853);
  });
});

// 예시: buttons 테스트 — 타임아웃
describe('waitForApproval', () => {
  it('타임아웃 시 false를 반환한다', async () => {
    vi.useFakeTimers();
    const promise = waitForApproval('test-id', 1000);
    vi.advanceTimersByTime(1000);
    expect(await promise).toBe(false);
    vi.useRealTimers();
  });
});
```

---

## 11. 복잡도 및 예상 파일 수

| 항목              | 값                         |
| ----------------- | -------------------------- |
| **복잡도**        | **L**                      |
| 소스 파일         | 14                         |
| 테스트 파일       | 8 (7 unit + vitest.config) |
| **합계**          | **~22 파일**               |
| 예상 LOC (소스)   | 1,000 ~ 1,400              |
| 예상 LOC (테스트) | 800 ~ 1,000                |
| 신규 의존성       | `discord.js ^14.25.1`      |
