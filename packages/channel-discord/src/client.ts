import { createLogger } from '@finclaw/infra';
import { Client, GatewayIntentBits, Partials, ActivityType } from 'discord.js';

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
