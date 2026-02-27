// packages/server/test/channels/dock.test.ts
import { describe, it, expect } from 'vitest';
import { createChannelDock, CORE_DOCKS } from '../../src/channels/dock.js';

describe('createChannelDock', () => {
  it('기본값을 병합한 ChannelDock을 반환한다', () => {
    const dock = createChannelDock({
      id: 'test',
      meta: { name: 'test', displayName: 'Test' },
      capabilities: {
        supportsMarkdown: false,
        supportsImages: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsButtons: false,
        supportsThreads: false,
        supportsReactions: false,
        supportsEditing: false,
        maxMessageLength: 1000,
      },
    });

    expect(dock.id).toBe('test');
    expect(dock.defaultChatType).toBe('group');
    expect(dock.threadingMode).toBe('none');
    expect(dock.outboundLimits).toEqual({
      maxChunkLength: 2000,
      maxMediaPerMessage: 1,
      rateLimitPerMinute: 30,
    });
  });

  it('명시적 옵션이 기본값을 덮어쓴다', () => {
    const dock = createChannelDock({
      id: 'custom',
      meta: { name: 'custom', displayName: 'Custom' },
      capabilities: {
        supportsMarkdown: true,
        supportsImages: true,
        supportsAudio: false,
        supportsVideo: false,
        supportsButtons: false,
        supportsThreads: true,
        supportsReactions: false,
        supportsEditing: false,
        maxMessageLength: 4000,
      },
      defaultChatType: 'direct',
      threadingMode: 'native',
      outboundLimits: { maxChunkLength: 4000, rateLimitPerMinute: 100 },
    });

    expect(dock.defaultChatType).toBe('direct');
    expect(dock.threadingMode).toBe('native');
    expect(dock.outboundLimits.maxChunkLength).toBe(4000);
    expect(dock.outboundLimits.rateLimitPerMinute).toBe(100);
    // 명시하지 않은 필드는 기본값 유지
    expect(dock.outboundLimits.maxMediaPerMessage).toBe(1);
  });

  it('id가 ChannelId 브랜드 타입으로 생성된다', () => {
    const dock = createChannelDock({
      id: 'branded',
      meta: { name: 'branded', displayName: 'Branded' },
      capabilities: {
        supportsMarkdown: false,
        supportsImages: false,
        supportsAudio: false,
        supportsVideo: false,
        supportsButtons: false,
        supportsThreads: false,
        supportsReactions: false,
        supportsEditing: false,
        maxMessageLength: 500,
      },
    });
    // 런타임에는 string이지만 브랜드 팩토리를 거침
    expect(typeof dock.id).toBe('string');
    expect(dock.id).toBe('branded');
  });
});

describe('CORE_DOCKS', () => {
  it('discord와 http-webhook 2개를 포함한다', () => {
    expect(CORE_DOCKS).toHaveLength(2);
    const ids = CORE_DOCKS.map((d) => d.id as string);
    expect(ids).toContain('discord');
    expect(ids).toContain('http-webhook');
  });

  it('frozen 배열이다', () => {
    expect(Object.isFrozen(CORE_DOCKS)).toBe(true);
  });

  it('discord 도크는 올바른 기능을 갖는다', () => {
    const discord = CORE_DOCKS.find((d) => (d.id as string) === 'discord');
    expect(discord).toBeDefined();
    expect(discord?.capabilities.supportsMarkdown).toBe(true);
    expect(discord?.capabilities.supportsThreads).toBe(true);
    expect(discord?.threadingMode).toBe('native');
    expect(discord?.defaultChatType).toBe('group');
  });

  it('http-webhook 도크는 기본적인 기능만 갖는다', () => {
    const webhook = CORE_DOCKS.find((d) => (d.id as string) === 'http-webhook');
    expect(webhook).toBeDefined();
    expect(webhook?.capabilities.supportsMarkdown).toBe(false);
    expect(webhook?.capabilities.supportsThreads).toBe(false);
    expect(webhook?.threadingMode).toBe('none');
    expect(webhook?.defaultChatType).toBe('direct');
  });
});
