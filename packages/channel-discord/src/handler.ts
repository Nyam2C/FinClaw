import type { InboundMessage, CleanupFn, ChatType } from '@finclaw/types';
import type { Client, Message as DiscordMessage } from 'discord.js';
import { createLogger } from '@finclaw/infra';
import { createChannelId, createTimestamp } from '@finclaw/types';

const log = createLogger({ name: 'channel-discord' });

export function setupMessageHandler(
  client: Client,
  handler: (msg: InboundMessage) => Promise<void>,
): CleanupFn {
  const onMessage = async (msg: DiscordMessage) => {
    // 봇 + 시스템 메시지 이중 체크
    if (msg.author.bot || msg.system) {
      return;
    }
    if (!client.user) {
      return;
    }

    const isDM = msg.channel.isDMBased();

    // 길드 메시지: 봇 멘션이 포함된 경우만 처리
    if (!isDM && !msg.mentions.has(client.user.id)) {
      return;
    }

    // 멘션 제거: cleanContent 사용 (regex 대신 — Unicode 닉네임 안전)
    const body = msg.cleanContent.trim();
    if (!body) {
      return;
    }

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
