import type { MsgContext, StorageAdapter } from '@finclaw/types';
import { createTimestamp, createSessionKey, createChannelId } from '@finclaw/types';
import { describe, it, expect, vi } from 'vitest';
import { registerBuiltInCommands } from '../commands/built-in.js';
import { InMemoryCommandRegistry } from '../commands/registry.js';
import { commandStage } from '../stages/command.js';

function makeCtx(overrides: Partial<MsgContext> = {}): MsgContext {
  return {
    body: '',
    bodyForAgent: '',
    rawBody: '',
    from: 'user1',
    senderId: 'user1',
    senderName: 'User One',
    provider: 'discord',
    channelId: createChannelId('discord'),
    chatType: 'direct',
    sessionKey: createSessionKey('test-session'),
    accountId: 'user1',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

describe('commandStage', () => {
  it('명령어가 아닌 메시지는 handled=false', async () => {
    const result = await commandStage('hello world', new InMemoryCommandRegistry(), '/', makeCtx());
    expect(result).toEqual({ handled: false });
  });

  it('등록된 명령어를 실행하고 결과를 돌려준다 (B4)', async () => {
    const registry = new InMemoryCommandRegistry();
    registerBuiltInCommands(registry, { storage: {} as StorageAdapter });
    const result = await commandStage('/help', registry, '/', makeCtx());
    expect(result.handled).toBe(true);
    expect(result.commandResult?.content).toContain('사용 가능한 명령어');
  });

  it('등록되지 않은 명령어는 handled=false', async () => {
    const result = await commandStage('/unknown', new InMemoryCommandRegistry(), '/', makeCtx());
    expect(result).toEqual({ handled: false });
  });

  it('코드 펜스 내부의 명령어는 무시한다', async () => {
    const registry = new InMemoryCommandRegistry();
    registerBuiltInCommands(registry, { storage: {} as StorageAdapter });
    const result = await commandStage('```\n/help\n```', registry, '/', makeCtx());
    expect(result).toEqual({ handled: false });
  });

  it('별칭으로 명령어를 실행한다', async () => {
    const registry = new InMemoryCommandRegistry();
    registerBuiltInCommands(registry, { storage: {} as StorageAdapter });
    const result = await commandStage('/h', registry, '/', makeCtx());
    expect(result.handled).toBe(true);
    expect(result.commandResult?.content).toContain('사용 가능한 명령어');
  });
});

describe('InMemoryCommandRegistry', () => {
  it('명령어를 등록하고 조회한다', () => {
    const registry = new InMemoryCommandRegistry();
    const executor = vi.fn();
    registry.register(
      {
        name: 'test',
        aliases: ['t'],
        description: 'Test command',
        usage: '/test',
      },
      executor,
    );

    const entry = registry.get('test');
    expect(entry).toBeDefined();
    expect(entry?.definition.name).toBe('test');
  });

  it('별칭으로 명령어를 조회한다', () => {
    const registry = new InMemoryCommandRegistry();
    registry.register(
      {
        name: 'test',
        aliases: ['t'],
        description: 'Test',
        usage: '/test',
      },
      vi.fn(),
    );

    expect(registry.get('t')).toBeDefined();
    expect(registry.get('t')?.definition.name).toBe('test');
  });

  it('명령어를 파싱한다', () => {
    const registry = new InMemoryCommandRegistry();
    const parsed = registry.parse('/price AAPL', '/');

    expect(parsed).toEqual({
      name: 'price',
      args: ['AAPL'],
      raw: '/price AAPL',
    });
  });

  it('명령어 접두사가 아니면 null을 반환한다', () => {
    const registry = new InMemoryCommandRegistry();
    expect(registry.parse('hello', '/')).toBeNull();
  });
});
