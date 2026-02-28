import type { MsgContext } from '@finclaw/types';
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
  it('명령어가 아닌 메시지는 continue를 반환한다', async () => {
    const registry = new InMemoryCommandRegistry();
    const result = await commandStage('hello world', registry, '/', makeCtx());

    expect(result.action).toBe('continue');
  });

  it('등록된 명령어를 파싱하고 skip을 반환한다', async () => {
    const registry = new InMemoryCommandRegistry();
    registerBuiltInCommands(registry);

    const result = await commandStage('/help', registry, '/', makeCtx());

    expect(result.action).toBe('skip');
    if (result.action !== 'skip') {
      return;
    }
    expect(result.reason).toContain('help');
  });

  it('등록되지 않은 명령어는 continue를 반환한다', async () => {
    const registry = new InMemoryCommandRegistry();
    const result = await commandStage('/unknown', registry, '/', makeCtx());

    expect(result.action).toBe('continue');
  });

  it('코드 펜스 내부의 명령어는 무시한다', async () => {
    const registry = new InMemoryCommandRegistry();
    registerBuiltInCommands(registry);

    const body = '```\n/help\n```';
    const result = await commandStage(body, registry, '/', makeCtx());

    expect(result.action).toBe('continue');
  });

  it('별칭으로 명령어를 실행한다', async () => {
    const registry = new InMemoryCommandRegistry();
    registerBuiltInCommands(registry);

    const result = await commandStage('/h', registry, '/', makeCtx());

    expect(result.action).toBe('skip');
    if (result.action !== 'skip') {
      return;
    }
    expect(result.reason).toContain('h');
  });

  it('requiredRoles가 있으면 skip (권한 부족)을 반환한다', async () => {
    const registry = new InMemoryCommandRegistry();
    registry.register(
      {
        name: 'admin',
        aliases: [],
        description: 'Admin command',
        usage: '/admin',
        category: 'admin',
        requiredRoles: ['admin'],
      },
      vi.fn(),
    );

    const result = await commandStage('/admin', registry, '/', makeCtx());

    expect(result.action).toBe('skip');
    if (result.action !== 'skip') {
      return;
    }
    expect(result.reason).toContain('permissions');
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
        category: 'general',
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
        category: 'general',
      },
      vi.fn(),
    );

    expect(registry.get('t')).toBeDefined();
    expect(registry.get('t')?.definition.name).toBe('test');
  });

  it('명령어를 해제한다', () => {
    const registry = new InMemoryCommandRegistry();
    registry.register(
      {
        name: 'test',
        aliases: ['t'],
        description: 'Test',
        usage: '/test',
        category: 'general',
      },
      vi.fn(),
    );

    expect(registry.unregister('test')).toBe(true);
    expect(registry.get('test')).toBeUndefined();
    expect(registry.get('t')).toBeUndefined();
  });

  it('카테고리별로 명령어를 필터링한다', () => {
    const registry = new InMemoryCommandRegistry();
    registerBuiltInCommands(registry);

    const finance = registry.listByCategory('finance');
    expect(finance.length).toBeGreaterThan(0);
    for (const cmd of finance) {
      expect(cmd.category).toBe('finance');
    }
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
