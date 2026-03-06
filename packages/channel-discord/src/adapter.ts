import type {
  ChannelPlugin,
  ChannelMeta,
  ChannelCapabilities,
  ChannelId,
  CleanupFn,
} from '@finclaw/types';
import type { InboundMessage, OutboundMessage } from '@finclaw/types';
import type { Client } from 'discord.js';
import { createLogger } from '@finclaw/infra';
import { createChannelId } from '@finclaw/types';
import type { DiscordAccount } from './types.js';
import { createDiscordClient } from './client.js';
import { registerGuildCommands } from './commands/index.js';
import { setupMessageHandler } from './handler.js';
import { sendOutboundMessage } from './sender.js';

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
    if (!this.client) {
      throw new Error('Client not initialized — call setup() first');
    }
    return setupMessageHandler(this.client, handler);
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.client) {
      throw new Error('Client not initialized — call setup() first');
    }
    await sendOutboundMessage(this.client, msg);
  }

  async sendTyping(channelId: string, chatId: string): Promise<void> {
    if (!this.client) {
      return;
    }
    const channel = await this.client.channels.fetch(chatId);
    if (channel && 'sendTyping' in channel) {
      await (channel as unknown as { sendTyping(): Promise<void> }).sendTyping();
    }
  }

  async addReaction(_messageId: string, _emoji: string): Promise<void> {
    // TODO: v0.2 — fetch message by ID, then react
  }
}
