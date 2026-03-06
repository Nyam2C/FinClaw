import type { OutboundMessage, ReplyPayload } from '@finclaw/types';
import type { Client, TextChannel, DMChannel, ThreadChannel } from 'discord.js';
import { createLogger } from '@finclaw/infra';
import { chunkText } from './chunking.js';

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
    await channel.send(payload.channelData as Record<string, unknown>);
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
