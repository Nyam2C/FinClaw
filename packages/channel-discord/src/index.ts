import { DiscordAdapter } from './adapter.js';

// 플러그인 인스턴스 (server가 import하여 사용)
export const discordAdapter = new DiscordAdapter();

// 타입 re-export
export type { DiscordAccount, SlashCommand, CommandDeps } from './types.js';
export { DiscordAdapter } from './adapter.js';
