import type { OutboundMessage, ChannelId } from '@finclaw/types';
import type { Client } from 'discord.js';
import { describe, it, expect, vi } from 'vitest';
import { sendOutboundMessage } from '../src/sender.js';

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
    await sendOutboundMessage(client as unknown as Client, makeOutbound());
    // send가 호출되지 않음 (채널이 null이므로)
  });

  it('텍스트 payload를 전송한다', async () => {
    const channel = makeChannel();
    const client = makeClient(channel);

    await sendOutboundMessage(
      client as unknown as Client,
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
      client as unknown as Client,
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
      client as unknown as Client,
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
      client as unknown as Client,
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
      client as unknown as Client,
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
      client as unknown as Client,
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
      client as unknown as Client,
      makeOutbound({
        payloads: [{ text: 'Thread msg' }],
        threadId: 'thread-1',
      }),
    );

    expect(client.channels.fetch).toHaveBeenCalledWith('thread-1');
  });
});
