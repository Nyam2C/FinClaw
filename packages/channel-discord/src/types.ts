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
