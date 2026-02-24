# Phase 12: Discord 채널 어댑터 (Discord Channel Adapter)

> **복잡도: L** | 소스 ~10 파일 | 테스트 ~7 파일 | 합계 ~17 파일

---

## 1. 목표

Discord를 통해 FinClaw 금융 AI 어시스턴트와 상호작용할 수 있는 채널 어댑터를 구현한다. OpenClaw의 Discord 어댑터(deep-dive/10)를 기반으로, 금융 도메인에 특화된 슬래시 커맨드와 임베드 포맷을 추가한다:

- **Discord.js v14 클라이언트**: 봇 설정, 인텐트 관리, 이벤트 핸들링
- **슬래시 커맨드**: `/ask` (일반 질의), `/market` (시세 조회), `/news` (금융 뉴스), `/alert` (알림 설정), `/config` (설정), `/status` (봇 상태)
- **텍스트 청킹**: 2000자 제한에 맞춘 메시지 분할 (마크다운 구조 보존)
- **실행 승인 버튼**: 도구 실행 전 사용자 확인 인터랙티브 컴포넌트
- **리치 임베드**: 주가 데이터, 뉴스, 포트폴리오 요약 등 금융 정보를 시각적으로 표현
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
- 범용 임베드 → 금융 데이터 전용 임베드 빌더 (주가 차트, 뉴스 카드, 포트폴리오)
- 채널 추상화: `ChannelPlugin` 인터페이스를 구현하여 다른 채널과 교환 가능

---

## 3. 생성할 파일

### 소스 파일 (`src/channels/discord/`)

| 파일 경로                                 | 설명                                                     |
| ----------------------------------------- | -------------------------------------------------------- |
| `src/channels/discord/index.ts`           | 모듈 public API re-export                                |
| `src/channels/discord/client.ts`          | Discord.js 클라이언트 초기화, 인텐트 설정, 이벤트 바인딩 |
| `src/channels/discord/adapter.ts`         | `ChannelPlugin` 인터페이스 구현 (채널 추상화 계층)       |
| `src/channels/discord/handler.ts`         | 메시지 이벤트 핸들러 (DM, 길드, 스레드)                  |
| `src/channels/discord/commands/index.ts`  | 슬래시 커맨드 레지스트리 및 길드 등록                    |
| `src/channels/discord/commands/ask.ts`    | `/ask` 커맨드 - 일반 AI 질의                             |
| `src/channels/discord/commands/market.ts` | `/market` 커맨드 - 시세 조회                             |
| `src/channels/discord/commands/news.ts`   | `/news` 커맨드 - 금융 뉴스                               |
| `src/channels/discord/commands/alert.ts`  | `/alert` 커맨드 - 가격 알림 설정/조회/삭제               |
| `src/channels/discord/chunking.ts`        | 2000자 텍스트 분할 (마크다운 경계 보존)                  |
| `src/channels/discord/embeds.ts`          | 리치 임베드 빌더 (시세, 뉴스, 포트폴리오, 에러)          |
| `src/channels/discord/buttons.ts`         | 인터랙티브 버튼 (도구 실행 승인/거부)                    |

### 테스트 파일

| 파일 경로                                      | 테스트 대상                                  |
| ---------------------------------------------- | -------------------------------------------- |
| `src/channels/discord/adapter.test.ts`         | ChannelPlugin 인터페이스 구현 (unit)         |
| `src/channels/discord/handler.test.ts`         | 메시지 핸들링, DM/길드 분기 (unit)           |
| `src/channels/discord/commands/index.test.ts`  | 커맨드 등록/디스패치 (unit)                  |
| `src/channels/discord/commands/market.test.ts` | /market 커맨드 입력 파싱, 임베드 생성 (unit) |
| `src/channels/discord/chunking.test.ts`        | 텍스트 분할, 마크다운 보존 (unit)            |
| `src/channels/discord/embeds.test.ts`          | 임베드 빌더 출력 검증 (unit)                 |
| `src/channels/discord/buttons.test.ts`         | 버튼 생성, 인터랙션 핸들링 (unit)            |

---

## 4. 핵심 인터페이스/타입

### ChannelPlugin 인터페이스 (Phase 5에서 정의, 여기서 구현)

```typescript
/**
 * 채널 추상화 인터페이스.
 * Discord, Slack, Telegram 등 다양한 채널을 동일한 인터페이스로 통합한다.
 * Phase 5에서 정의된 인터페이스를 Discord 어댑터가 구현한다.
 */
export interface ChannelPlugin {
  readonly name: string;
  readonly type: 'discord' | 'slack' | 'telegram' | 'web';

  /** 채널 시작 (봇 로그인, 이벤트 리스너 등록) */
  start(): Promise<void>;

  /** 채널 종료 (봇 로그아웃, 리소스 정리) */
  stop(): Promise<void>;

  /** 메시지 전송 */
  send(target: ChannelTarget, message: ChannelMessage): Promise<void>;

  /** 수신 메시지 핸들러 등록 */
  onMessage(handler: IncomingMessageHandler): void;

  /** 채널 상태 조회 */
  status(): ChannelStatus;
}

/** 채널 대상 (메시지 송신처) */
export interface ChannelTarget {
  readonly channelId: string;
  readonly threadId?: string;
  readonly userId?: string; // DM인 경우
  readonly replyToMessageId?: string; // 답장인 경우
}

/** 채널 메시지 (송신용) */
export interface ChannelMessage {
  readonly content?: string;
  readonly embeds?: readonly ChannelEmbed[];
  readonly components?: readonly ChannelComponent[];
  readonly files?: readonly ChannelFile[];
}

/** 수신 메시지 */
export interface IncomingMessage {
  readonly id: string;
  readonly channelId: string;
  readonly userId: string;
  readonly userName: string;
  readonly content: string;
  readonly isDM: boolean;
  readonly threadId?: string;
  readonly guildId?: string;
  readonly timestamp: number;
}

/** 수신 메시지 핸들러 */
export type IncomingMessageHandler = (message: IncomingMessage) => Promise<void>;

/** 채널 상태 */
export interface ChannelStatus {
  readonly connected: boolean;
  readonly latencyMs: number;
  readonly guilds: number;
  readonly uptime: number;
}
```

### Discord 특화 타입

```typescript
/** Discord 봇 설정 */
export interface DiscordConfig {
  readonly token: string; // 봇 토큰
  readonly clientId: string; // 앱 클라이언트 ID
  readonly guildIds?: readonly string[]; // 슬래시 커맨드 등록 대상 길드
  readonly allowDMs: boolean; // DM 허용 여부 (기본 true)
  readonly typingInterval: number; // 타이핑 표시 갱신 간격 (기본 5000ms)
  readonly maxChunkLength: number; // 메시지 분할 최대 길이 (기본 2000)
  readonly approvalRequired: boolean; // 도구 실행 승인 필요 여부 (기본 false)
}

/** 슬래시 커맨드 정의 */
export interface SlashCommand {
  readonly data: SlashCommandBuilder; // discord.js 빌더 객체
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

/** 임베드 데이터: 시세 */
export interface MarketQuoteData {
  readonly ticker: string;
  readonly name: string;
  readonly price: number;
  readonly change: number;
  readonly changePercent: number;
  readonly volume: number;
  readonly marketCap?: number;
  readonly high52w?: number;
  readonly low52w?: number;
  readonly updatedAt: string;
}

/** 임베드 데이터: 뉴스 */
export interface NewsArticleData {
  readonly title: string;
  readonly source: string;
  readonly url: string;
  readonly summary: string;
  readonly publishedAt: string;
  readonly sentiment?: 'positive' | 'neutral' | 'negative';
  readonly relatedTickers?: readonly string[];
}

/** 임베드 데이터: 알림 */
export interface AlertData {
  readonly id: string;
  readonly ticker: string;
  readonly condition: 'above' | 'below' | 'change_percent';
  readonly threshold: number;
  readonly currentPrice: number;
  readonly createdAt: string;
  readonly triggeredAt?: string;
}

/** 버튼 인터랙션 데이터 */
export interface ApprovalButtonData {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly toolInput: string; // 표시용 (축약)
  readonly sessionId: string;
  readonly userId: string;
}
```

---

## 5. 구현 상세

### 5.1 Discord 클라이언트 (`client.ts`)

Discord.js v14 클라이언트를 초기화하고, 필요한 인텐트와 파티셔닝을 설정한다.

```typescript
import { Client, GatewayIntentBits, Partials, ActivityType, type ClientEvents } from 'discord.js';
import type { DiscordConfig } from './types.js';

/**
 * Discord.js 클라이언트를 생성하고 설정한다.
 *
 * 필수 인텐트:
 * - Guilds: 서버 정보 접근
 * - GuildMessages: 서버 메시지 수신
 * - DirectMessages: DM 수신
 * - MessageContent: 메시지 내용 접근 (Privileged Intent)
 */
export function createDiscordClient(config: DiscordConfig): Client {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [
      Partials.Channel, // DM 채널 접근
      Partials.Message, // 캐시되지 않은 메시지 접근
    ],
  });

  // 준비 완료 이벤트
  client.once('ready', (readyClient) => {
    console.log(`[discord] Logged in as ${readyClient.user.tag}`);
    console.log(`[discord] Serving ${readyClient.guilds.cache.size} guilds`);

    // 봇 상태 설정
    readyClient.user.setActivity('금융 AI 어시스턴트', {
      type: ActivityType.Playing,
    });
  });

  // 에러 핸들링
  client.on('error', (error) => {
    console.error('[discord] Client error:', error.message);
  });

  // 재연결 이벤트
  client.on('shardReconnecting', (shardId) => {
    console.log(`[discord] Shard ${shardId} reconnecting...`);
  });

  return client;
}

/**
 * 봇 로그인 및 슬래시 커맨드 등록
 */
export async function startClient(client: Client, config: DiscordConfig): Promise<void> {
  await client.login(config.token);

  // 슬래시 커맨드 등록 (길드 단위)
  if (config.guildIds?.length) {
    await registerGuildCommands(client, config);
  }
}

/**
 * 봇 종료
 */
export async function stopClient(client: Client): Promise<void> {
  client.removeAllListeners();
  await client.destroy();
  console.log('[discord] Client destroyed');
}
```

### 5.2 ChannelPlugin 구현 (`adapter.ts`)

Discord 클라이언트를 `ChannelPlugin` 인터페이스로 래핑하여, 상위 레이어에서 채널에 독립적으로 사용할 수 있게 한다.

```typescript
import type { Client, TextChannel, DMChannel, ThreadChannel } from 'discord.js';
import type {
  ChannelPlugin,
  ChannelTarget,
  ChannelMessage,
  ChannelStatus,
  IncomingMessageHandler,
} from '../../types/channels.js';
import type { DiscordConfig } from './types.js';
import { createDiscordClient, startClient, stopClient } from './client.js';
import { setupMessageHandler } from './handler.js';
import { registerCommands } from './commands/index.js';
import { chunkText } from './chunking.js';
import { buildDiscordEmbed } from './embeds.js';
import { buildActionRow } from './buttons.js';

export class DiscordAdapter implements ChannelPlugin {
  readonly name = 'discord';
  readonly type = 'discord' as const;

  private client: Client;
  private readonly config: DiscordConfig;
  private startedAt = 0;
  private messageHandlers: IncomingMessageHandler[] = [];

  constructor(config: DiscordConfig) {
    this.config = config;
    this.client = createDiscordClient(config);
  }

  async start(): Promise<void> {
    // 메시지 핸들러 설정
    setupMessageHandler(this.client, this.config, (msg) => {
      return Promise.all(this.messageHandlers.map((handler) => handler(msg))).then(() => {});
    });

    // 슬래시 커맨드 등록
    await registerCommands(this.client, this.config);

    // 봇 로그인
    await startClient(this.client, this.config);
    this.startedAt = Date.now();
  }

  async stop(): Promise<void> {
    await stopClient(this.client);
  }

  /**
   * 메시지 전송.
   * 2000자 제한을 고려하여 자동 분할한다.
   */
  async send(target: ChannelTarget, message: ChannelMessage): Promise<void> {
    const channel = await this.resolveChannel(target);
    if (!channel) return;

    // 텍스트 콘텐츠 청킹
    if (message.content) {
      const chunks = chunkText(message.content, this.config.maxChunkLength);

      for (let i = 0; i < chunks.length; i++) {
        const isLast = i === chunks.length - 1;

        await channel.send({
          content: chunks[i],
          // 임베드와 컴포넌트는 마지막 청크에만 첨부
          embeds: isLast ? message.embeds?.map(buildDiscordEmbed) : undefined,
          components: isLast ? message.components?.map(buildActionRow) : undefined,
          ...(target.replyToMessageId && i === 0
            ? { reply: { messageReference: target.replyToMessageId } }
            : {}),
        });
      }
    } else if (message.embeds?.length) {
      // 텍스트 없이 임베드만 전송
      await channel.send({
        embeds: message.embeds.map(buildDiscordEmbed),
        components: message.components?.map(buildActionRow),
      });
    }
  }

  onMessage(handler: IncomingMessageHandler): void {
    this.messageHandlers.push(handler);
  }

  status(): ChannelStatus {
    return {
      connected: this.client.isReady(),
      latencyMs: this.client.ws.ping,
      guilds: this.client.guilds.cache.size,
      uptime: this.startedAt ? Date.now() - this.startedAt : 0,
    };
  }

  /** 대상 채널 해석 */
  private async resolveChannel(
    target: ChannelTarget,
  ): Promise<TextChannel | DMChannel | ThreadChannel | null> {
    if (target.threadId) {
      return this.client.channels.fetch(target.threadId) as Promise<ThreadChannel>;
    }
    if (target.userId) {
      const user = await this.client.users.fetch(target.userId);
      return user.createDM();
    }
    return this.client.channels.fetch(target.channelId) as Promise<TextChannel>;
  }
}
```

### 5.3 메시지 핸들러 (`handler.ts`)

Discord 메시지 이벤트를 수신하여 내부 `IncomingMessage` 포맷으로 변환한다.

```typescript
import type { Client, Message as DiscordMessage } from 'discord.js';
import type { DiscordConfig } from './types.js';
import type { IncomingMessage, IncomingMessageHandler } from '../../types/channels.js';

/**
 * Discord messageCreate 이벤트를 처리한다.
 *
 * 필터링 규칙:
 * 1. 봇 메시지 무시
 * 2. DM 허용 설정 확인
 * 3. 봇 멘션 또는 DM인 경우만 처리
 */
export function setupMessageHandler(
  client: Client,
  config: DiscordConfig,
  handler: IncomingMessageHandler,
): void {
  client.on('messageCreate', async (msg: DiscordMessage) => {
    // 봇 메시지 무시
    if (msg.author.bot) return;

    // DM 여부 판별
    const isDM = msg.channel.isDMBased();

    // DM 허용 설정 확인
    if (isDM && !config.allowDMs) return;

    // 길드 메시지: 봇 멘션이 포함된 경우만 처리
    if (!isDM && !msg.mentions.has(client.user!.id)) return;

    // 봇 멘션 제거 후 실제 콘텐츠 추출
    const content = msg.content.replace(new RegExp(`<@!?${client.user!.id}>`, 'g'), '').trim();

    if (!content) return;

    // 타이핑 인디케이터 시작
    const typingInterval = startTypingIndicator(msg.channel, config.typingInterval);

    try {
      const incoming: IncomingMessage = {
        id: msg.id,
        channelId: msg.channelId,
        userId: msg.author.id,
        userName: msg.author.displayName ?? msg.author.username,
        content,
        isDM,
        threadId: msg.channel.isThread() ? msg.channelId : undefined,
        guildId: msg.guildId ?? undefined,
        timestamp: msg.createdTimestamp,
      };

      await handler(incoming);
    } finally {
      clearInterval(typingInterval);
    }
  });
}

/**
 * 타이핑 인디케이터를 주기적으로 갱신한다.
 * Discord의 타이핑 표시는 약 10초 후 자동 소멸하므로, 주기적으로 재전송해야 한다.
 */
function startTypingIndicator(channel: any, intervalMs: number): ReturnType<typeof setInterval> {
  channel.sendTyping?.();
  return setInterval(() => {
    channel.sendTyping?.();
  }, intervalMs);
}
```

### 5.4 슬래시 커맨드 (`commands/`)

```typescript
// commands/index.ts - 커맨드 레지스트리
import { REST, Routes, type Client, type ChatInputCommandInteraction } from 'discord.js';
import type { DiscordConfig, SlashCommand } from '../types.js';
import { askCommand } from './ask.js';
import { marketCommand } from './market.js';
import { newsCommand } from './news.js';
import { alertCommand } from './alert.js';

const commands: SlashCommand[] = [askCommand, marketCommand, newsCommand, alertCommand];

/**
 * 슬래시 커맨드를 Discord에 등록한다.
 * 글로벌 등록 대신 길드 단위 등록을 사용하여 즉시 반영한다.
 */
export async function registerCommands(client: Client, config: DiscordConfig): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.token);
  const commandData = commands.map((cmd) => cmd.data.toJSON());

  if (config.guildIds?.length) {
    // 길드 단위 등록 (즉시 반영)
    for (const guildId of config.guildIds) {
      await rest.put(Routes.applicationGuildCommands(config.clientId, guildId), {
        body: commandData,
      });
      console.log(`[discord] Registered ${commands.length} commands for guild ${guildId}`);
    }
  } else {
    // 글로벌 등록 (최대 1시간 소요)
    await rest.put(Routes.applicationCommands(config.clientId), { body: commandData });
    console.log(`[discord] Registered ${commands.length} global commands`);
  }

  // 인터랙션 핸들러
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = commands.find((cmd) => cmd.data.name === interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      const content = `명령 실행 중 오류가 발생했습니다: ${(error as Error).message}`;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, ephemeral: true });
      } else {
        await interaction.reply({ content, ephemeral: true });
      }
    }
  });
}

// commands/market.ts - /market 커맨드
import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand, MarketQuoteData } from '../types.js';
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
    )
    .addStringOption((option) =>
      option
        .setName('period')
        .setDescription('조회 기간')
        .addChoices(
          { name: '1일', value: '1d' },
          { name: '1주', value: '1w' },
          { name: '1개월', value: '1m' },
          { name: '3개월', value: '3m' },
          { name: '1년', value: '1y' },
        ),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const ticker = interaction.options.getString('ticker', true);
    const period = interaction.options.getString('period') ?? '1d';

    await interaction.deferReply();

    try {
      // 시세 데이터 조회 (skills-finance 모듈 호출)
      const quote: MarketQuoteData = await fetchMarketQuote(ticker);
      const embed = buildMarketEmbed(quote);

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply({
        content: `시세 조회 실패: ${(error as Error).message}`,
      });
    }
  },
};

// commands/news.ts - /news 커맨드
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

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const query = interaction.options.getString('query') ?? '주요 금융 뉴스';
    const count = interaction.options.getInteger('count') ?? 5;

    await interaction.deferReply();

    // 뉴스 검색 (skills-finance 모듈 호출)
    const articles: NewsArticleData[] = await searchFinanceNews(query, count);
    const embeds = articles.map(buildNewsEmbed);

    await interaction.editReply({ embeds });
  },
};

// commands/alert.ts - /alert 커맨드
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

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'set': {
        const ticker = interaction.options.getString('ticker', true);
        const condition = interaction.options.getString('condition', true);
        const value = interaction.options.getNumber('value', true);
        // 알림 생성 → storage에 저장
        await interaction.reply({
          content: `알림 설정 완료: ${ticker} ${condition} ${value}`,
          ephemeral: true,
        });
        break;
      }
      case 'list': {
        // 사용자의 활성 알림 목록 조회
        await interaction.deferReply({ ephemeral: true });
        const alerts: AlertData[] = await getUserAlerts(interaction.user.id);
        const embeds = alerts.map(buildAlertEmbed);
        await interaction.editReply({ embeds });
        break;
      }
      case 'remove': {
        const id = interaction.options.getString('id', true);
        // 알림 삭제
        await interaction.reply({ content: `알림 ${id} 삭제 완료`, ephemeral: true });
        break;
      }
    }
  },
};

// commands/ask.ts - /ask 커맨드 (범용 AI 질의)
export const askCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('FinClaw AI에게 질문합니다')
    .addStringOption((option) =>
      option.setName('question').setDescription('질문 내용').setRequired(true),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    const question = interaction.options.getString('question', true);

    await interaction.deferReply();

    // 실행 엔진을 통해 AI 응답 생성
    // 결과를 청킹하여 전송
    const result = await executeQuery(question, interaction.user.id);
    const chunks = chunkText(result.content, 2000);

    await interaction.editReply({ content: chunks[0] });

    // 2번째 청크부터는 followUp
    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i] });
    }
  },
};
```

### 5.5 텍스트 청킹 (`chunking.ts`)

2000자 제한에 맞춰 텍스트를 분할하되, 마크다운 구조를 가능한 보존한다.

````typescript
/**
 * 텍스트를 maxLength 이하의 청크로 분할한다.
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
export function chunkText(text: string, maxLength: number = 2000): string[] {
  if (text.length <= maxLength) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let inCodeBlock = false;
  let codeBlockLang = '';

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining);
      break;
    }

    // maxLength 이내에서 최적의 분할 지점 탐색
    let splitIndex = findSplitPoint(remaining, maxLength);

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

/** 분할 지점 탐색 */
function findSplitPoint(text: string, maxLength: number): number {
  const searchRange = text.slice(0, maxLength);

  // 1. 빈 줄 (단락 경계)
  const doubleNewline = searchRange.lastIndexOf('\n\n');
  if (doubleNewline > maxLength * 0.5) return doubleNewline + 2;

  // 2. 줄바꿈
  const newline = searchRange.lastIndexOf('\n');
  if (newline > maxLength * 0.3) return newline + 1;

  // 3. 마침표 + 공백 (문장 경계)
  const sentence = searchRange.lastIndexOf('. ');
  if (sentence > maxLength * 0.3) return sentence + 2;

  // 4. 공백 (단어 경계)
  const space = searchRange.lastIndexOf(' ');
  if (space > maxLength * 0.3) return space + 1;

  // 5. 강제 분할
  return maxLength;
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

```typescript
import { EmbedBuilder, type APIEmbed } from 'discord.js';
import type { MarketQuoteData, NewsArticleData, AlertData } from './types.js';

/** 시세 임베드 */
export function buildMarketEmbed(quote: MarketQuoteData): EmbedBuilder {
  const isPositive = quote.change >= 0;
  const arrow = isPositive ? '▲' : '▼';
  const color = isPositive ? 0x00c853 : 0xff1744; // 녹색/빨간색

  return new EmbedBuilder()
    .setTitle(`${quote.ticker} - ${quote.name}`)
    .setColor(color)
    .addFields(
      {
        name: '현재가',
        value: `**${formatCurrency(quote.price)}**`,
        inline: true,
      },
      {
        name: '변동',
        value: `${arrow} ${formatCurrency(Math.abs(quote.change))} (${quote.changePercent.toFixed(2)}%)`,
        inline: true,
      },
      {
        name: '거래량',
        value: formatNumber(quote.volume),
        inline: true,
      },
    )
    .addFields(
      ...(quote.marketCap
        ? [
            {
              name: '시가총액',
              value: formatLargeNumber(quote.marketCap),
              inline: true,
            },
          ]
        : []),
      ...(quote.high52w
        ? [
            {
              name: '52주 최고',
              value: formatCurrency(quote.high52w),
              inline: true,
            },
          ]
        : []),
      ...(quote.low52w
        ? [
            {
              name: '52주 최저',
              value: formatCurrency(quote.low52w),
              inline: true,
            },
          ]
        : []),
    )
    .setFooter({ text: `마지막 업데이트: ${quote.updatedAt}` })
    .setTimestamp();
}

/** 뉴스 임베드 */
export function buildNewsEmbed(article: NewsArticleData): EmbedBuilder {
  const sentimentEmoji: Record<string, string> = {
    positive: '+',
    neutral: '~',
    negative: '-',
  };

  const embed = new EmbedBuilder()
    .setTitle(article.title)
    .setURL(article.url)
    .setDescription(article.summary)
    .setColor(0x1565c0)
    .addFields(
      { name: '출처', value: article.source, inline: true },
      { name: '발행일', value: article.publishedAt, inline: true },
    );

  if (article.sentiment) {
    embed.addFields({
      name: '감성',
      value: `[${sentimentEmoji[article.sentiment]}] ${article.sentiment}`,
      inline: true,
    });
  }

  if (article.relatedTickers?.length) {
    embed.addFields({
      name: '관련 종목',
      value: article.relatedTickers.join(', '),
    });
  }

  return embed;
}

/** 알림 임베드 */
export function buildAlertEmbed(alert: AlertData): EmbedBuilder {
  const conditionText: Record<string, string> = {
    above: '이상',
    below: '이하',
    change_percent: '변동률',
  };

  return new EmbedBuilder()
    .setTitle(`알림: ${alert.ticker}`)
    .setColor(alert.triggeredAt ? 0xff9800 : 0x9e9e9e)
    .addFields(
      { name: '조건', value: `${conditionText[alert.condition]} ${alert.threshold}`, inline: true },
      { name: '현재가', value: String(alert.currentPrice), inline: true },
      { name: '설정일', value: alert.createdAt, inline: true },
    )
    .setFooter({ text: `ID: ${alert.id}` });
}

/** 에러 임베드 */
export function buildErrorEmbed(message: string): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle('오류 발생')
    .setDescription(message)
    .setColor(0xff1744)
    .setTimestamp();
}

// --- 포맷팅 유틸리티 ---

function formatCurrency(value: number): string {
  return value.toLocaleString('ko-KR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
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

도구 실행 전 사용자 확인을 받기 위한 인터랙티브 컴포넌트.

```typescript
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
  type Client,
  ComponentType,
} from 'discord.js';
import type { ApprovalButtonData } from './types.js';

/** 승인/거부 버튼 행 생성 */
export function buildApprovalRow(data: ApprovalButtonData): ActionRowBuilder<ButtonBuilder> {
  const approveId = `approve:${data.toolCallId}`;
  const denyId = `deny:${data.toolCallId}`;

  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(approveId)
      .setLabel('실행 승인')
      .setStyle(ButtonStyle.Success)
      .setEmoji({ name: undefined }),
    new ButtonBuilder().setCustomId(denyId).setLabel('거부').setStyle(ButtonStyle.Danger),
  );
}

/** 도구 실행 승인 요청 메시지 생성 */
export function buildApprovalMessage(data: ApprovalButtonData): {
  content: string;
  components: ActionRowBuilder<ButtonBuilder>[];
} {
  const truncatedInput =
    data.toolInput.length > 100 ? data.toolInput.slice(0, 100) + '...' : data.toolInput;

  return {
    content: [
      `**도구 실행 승인 요청**`,
      `- 도구: \`${data.toolName}\``,
      `- 입력: \`${truncatedInput}\``,
      ``,
      `실행을 승인하시겠습니까?`,
    ].join('\n'),
    components: [buildApprovalRow(data)],
  };
}

/**
 * 버튼 인터랙션 핸들러를 등록한다.
 *
 * 승인: toolCallId를 resolve하여 실행 엔진이 도구를 실행하도록 한다.
 * 거부: toolCallId를 reject하여 도구 실행을 건너뛴다.
 */
export function setupApprovalHandler(
  client: Client,
  onApprove: (toolCallId: string) => void,
  onDeny: (toolCallId: string) => void,
): void {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isButton()) return;

    const [action, toolCallId] = interaction.customId.split(':');
    if (!action || !toolCallId) return;
    if (action !== 'approve' && action !== 'deny') return;

    // 원래 요청자만 승인/거부 가능
    // interaction.user.id === originalUserId 확인

    if (action === 'approve') {
      onApprove(toolCallId);
      await interaction.update({
        content: `도구 실행이 승인되었습니다.`,
        components: [], // 버튼 제거
      });
    } else {
      onDeny(toolCallId);
      await interaction.update({
        content: `도구 실행이 거부되었습니다.`,
        components: [],
      });
    }
  });
}
```

### 데이터 흐름 다이어그램

```
Discord Server
     │
     ├── 메시지 (@FinClaw 멘션 또는 DM)
     │       │
     │       ▼
     │   ┌────────────────┐
     │   │ Message Handler │ → IncomingMessage 변환
     │   └───────┬────────┘
     │           │
     │           ▼
     │   ┌────────────────┐     ┌──────────────┐
     │   │ ChannelPlugin  │────▶│ Execution    │
     │   │ (adapter.ts)   │     │ Engine       │
     │   └───────┬────────┘     │ (Phase 9)    │
     │           │              └──────┬───────┘
     │           │                     │
     │           ▼                     ▼
     │   ┌────────────────┐   ┌──────────────┐
     │   │ Text Chunking  │   │ Tool Results │
     │   │ (≤2000 chars)  │   └──────┬───────┘
     │   └───────┬────────┘          │
     │           │              ┌────┘
     │           ▼              ▼
     │   ┌──────────────────────────┐
     │   │ Discord.js Send          │
     │   │ (embeds + buttons)       │
     │   └──────────────────────────┘
     │
     ├── 슬래시 커맨드 (/market AAPL)
     │       │
     │       ▼
     │   ┌────────────────┐
     │   │ Command Router │
     │   └───────┬────────┘
     │           │
     │     ┌─────┼─────┬──────┐
     │     ▼     ▼     ▼      ▼
     │   /ask  /market /news  /alert
     │     │     │      │      │
     │     ▼     ▼      ▼      ▼
     │   ┌──────────────────────────┐
     │   │ Rich Embed Builder       │
     │   │ (시세/뉴스/알림 임베드)    │
     │   └──────────────────────────┘
     │
     └── 버튼 인터랙션 (승인/거부)
             │
             ▼
         ┌────────────────┐
         │ Approval Handler│ → resolve/reject toolCallId
         └────────────────┘
```

---

## 6. 선행 조건

| Phase        | 구체적 산출물                                                              | 필요 이유                                                     |
| ------------ | -------------------------------------------------------------------------- | ------------------------------------------------------------- |
| **Phase 5**  | `src/types/channels.ts` - `ChannelPlugin`, `IncomingMessage` 등 인터페이스 | Discord 어댑터가 구현해야 할 채널 추상화 인터페이스           |
| **Phase 5**  | `src/channels/index.ts` - 채널 레지스트리                                  | Discord 어댑터를 채널 목록에 등록하는 매커니즘                |
| **Phase 9**  | `src/execution/runner.ts` - 실행 엔진                                      | `/ask` 커맨드 및 메시지 핸들러가 AI 응답 생성을 위해 호출     |
| **Phase 10** | `src/gateway/server.ts` - 게이트웨이 서버                                  | Discord 어댑터가 게이트웨이를 통해 실행 엔진과 통신 (옵션)    |
| **Phase 7**  | `src/skills/finance/` - 금융 스킬                                          | `/market`, `/news`, `/alert` 커맨드가 금융 데이터 조회에 사용 |
| **Phase 3**  | `src/storage/` - 저장소 모듈                                               | 알림 데이터 영구 저장에 사용                                  |

---

## 7. 산출물 및 검증

### 테스트 가능한 결과물

| 산출물             | 검증 방법                                              |
| ------------------ | ------------------------------------------------------ |
| ChannelPlugin 구현 | unit: start/stop 호출, send 메서드 동작, status 반환값 |
| 메시지 핸들러      | unit: 봇 메시지 무시, 멘션 감지, DM 처리, 콘텐츠 추출  |
| 슬래시 커맨드 등록 | unit: 커맨드 데이터 빌드, REST API 호출 mock           |
| /market 커맨드     | unit: ticker 파싱, 시세 임베드 빌드                    |
| /news 커맨드       | unit: 뉴스 검색 파라미터, 임베드 빌드                  |
| /alert 커맨드      | unit: set/list/remove 서브커맨드 분기                  |
| 텍스트 청킹        | unit: 2000자 분할, 마크다운 보존, 코드 블록 처리       |
| 리치 임베드        | unit: 시세/뉴스/알림/에러 임베드 필드 및 색상 검증     |
| 승인 버튼          | unit: 버튼 생성, approve/deny 핸들링                   |

### 검증 기준

```bash
# 단위 테스트 (Discord.js mock 사용, 실제 봇 연결 불필요)
pnpm test -- src/channels/discord/

# 커버리지 목표: statements 80%, branches 75%
pnpm test:coverage -- src/channels/discord/
```

### 테스트 전략

Discord.js 클라이언트를 직접 테스트하기 어려우므로, 다음 전략을 사용한다:

````typescript
// 테스트용 Discord.js mock 예시
import { describe, it, expect, vi } from 'vitest';
import { chunkText } from './chunking.js';
import { buildMarketEmbed } from './embeds.js';

// 1. 순수 함수 테스트 (chunking, embeds)
describe('chunkText', () => {
  it('2000자 이하 텍스트는 분할하지 않는다', () => {
    const text = 'Hello, world!';
    expect(chunkText(text, 2000)).toEqual([text]);
  });

  it('단락 경계에서 분할한다', () => {
    const text = 'A'.repeat(1500) + '\n\n' + 'B'.repeat(800);
    const chunks = chunkText(text, 2000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toEndWith('A');
    expect(chunks[1]).toStartWith('B');
  });

  it('코드 블록 내부 분할 시 블록을 닫고 다시 연다', () => {
    const text = '```python\n' + 'x = 1\n'.repeat(400) + '```';
    const chunks = chunkText(text, 2000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0]).toEndWith('```');
    expect(chunks[1]).toStartWith('```python');
  });
});

// 2. 임베드 빌더 테스트
describe('buildMarketEmbed', () => {
  it('상승 시세는 녹색으로 표시한다', () => {
    const embed = buildMarketEmbed({
      ticker: 'AAPL',
      name: 'Apple Inc.',
      price: 195.5,
      change: 3.25,
      changePercent: 1.69,
      volume: 54_000_000,
      updatedAt: '2026-02-23T15:30:00Z',
    });
    expect(embed.data.color).toBe(0x00c853);
    expect(embed.data.title).toBe('AAPL - Apple Inc.');
  });

  it('하락 시세는 빨간색으로 표시한다', () => {
    const embed = buildMarketEmbed({
      ticker: '005930.KS',
      name: '삼성전자',
      price: 72_300,
      change: -1_200,
      changePercent: -1.63,
      volume: 12_000_000,
      updatedAt: '2026-02-23T15:30:00Z',
    });
    expect(embed.data.color).toBe(0xff1744);
  });
});

// 3. 인터랙션 mock 테스트
describe('market command', () => {
  it('ticker 옵션을 파싱하여 시세 조회 후 임베드 응답한다', async () => {
    const interaction = createMockInteraction({
      commandName: 'market',
      options: { ticker: 'AAPL' },
    });

    await marketCommand.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        embeds: expect.arrayContaining([expect.any(Object)]),
      }),
    );
  });
});
````

### Live 테스트 (실제 Discord 봇)

```typescript
// test/live/discord.live.test.ts (DISCORD_TOKEN 환경변수 필요)
import { describe, it, expect } from 'vitest';

describe('Discord bot live test', () => {
  it('봇이 성공적으로 로그인한다', async () => {
    const adapter = new DiscordAdapter({
      token: process.env.DISCORD_TOKEN!,
      clientId: process.env.DISCORD_CLIENT_ID!,
      guildIds: [process.env.TEST_GUILD_ID!],
      allowDMs: true,
      typingInterval: 5000,
      maxChunkLength: 2000,
      approvalRequired: false,
    });

    await adapter.start();
    const status = adapter.status();

    expect(status.connected).toBe(true);
    expect(status.guilds).toBeGreaterThan(0);

    await adapter.stop();
  });
});
```

---

## 8. 복잡도 및 예상 파일 수

| 항목              | 값           |
| ----------------- | ------------ |
| **복잡도**        | **L**        |
| 소스 파일         | 10           |
| 테스트 파일       | 7            |
| **합계**          | **~17 파일** |
| 예상 LOC (소스)   | 900 ~ 1,200  |
| 예상 LOC (테스트) | 700 ~ 900    |
| 신규 의존성       | `discord.js` |
| 예상 구현 시간    | 2-3일        |
