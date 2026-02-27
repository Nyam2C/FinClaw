import type { PluginHook, PluginService, PluginCommand } from '@finclaw/types';
// packages/server/test/plugins/registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { RegistryFrozenError } from '../../src/plugins/errors.js';
import {
  createEmptyRegistry,
  getPluginRegistry,
  setPluginRegistry,
  freezeRegistry,
  isRegistryFrozen,
  registerToSlot,
  getSlot,
} from '../../src/plugins/registry.js';

beforeEach(() => {
  setPluginRegistry(createEmptyRegistry());
});

describe('createEmptyRegistry', () => {
  it('8개 슬롯을 빈 배열로 초기화한다', () => {
    const reg = createEmptyRegistry();
    expect(Object.keys(reg)).toHaveLength(8);
    for (const slot of Object.values(reg)) {
      expect(slot).toEqual([]);
    }
  });
});

describe('globalThis 싱글턴', () => {
  it('getPluginRegistry는 동일 인스턴스를 반환한다', () => {
    const a = getPluginRegistry();
    const b = getPluginRegistry();
    expect(a).toBe(b);
  });

  it('setPluginRegistry로 교체하면 이후 get이 새 인스턴스를 반환한다', () => {
    const prev = getPluginRegistry();
    const next = createEmptyRegistry();
    setPluginRegistry(next);
    expect(getPluginRegistry()).toBe(next);
    expect(getPluginRegistry()).not.toBe(prev);
  });
});

describe('registerToSlot / getSlot', () => {
  it('hooks 슬롯에 등록하고 조회한다', () => {
    const hook: PluginHook = {
      name: 'onConfigChange',
      priority: 0,
      handler: async () => {},
      pluginName: 'test',
    };
    registerToSlot('hooks', hook);
    const hooks = getSlot('hooks');
    expect(hooks).toHaveLength(1);
    expect(hooks[0].pluginName).toBe('test');
  });

  it('services 슬롯에 등록하고 조회한다', () => {
    const svc: PluginService = {
      name: 'test-svc',
      start: async () => {},
      stop: async () => {},
    };
    registerToSlot('services', svc);
    expect(getSlot('services')).toHaveLength(1);
  });

  it('commands 슬롯에 등록하고 조회한다', () => {
    const cmd: PluginCommand = {
      name: 'test-cmd',
      description: 'test',
      handler: async () => 'ok',
      pluginName: 'test',
    };
    registerToSlot('commands', cmd);
    expect(getSlot('commands')).toHaveLength(1);
  });

  it('routes 슬롯에 등록하고 조회한다', () => {
    registerToSlot('routes', {
      method: 'GET',
      path: '/health',
      handler: async () => {},
      pluginName: 'test',
    });
    expect(getSlot('routes')).toHaveLength(1);
  });

  it('diagnostics 슬롯에 등록하고 조회한다', () => {
    registerToSlot('diagnostics', {
      pluginName: 'test',
      timestamp: Date.now(),
      severity: 'info',
      phase: 'runtime',
      message: 'ok',
    });
    expect(getSlot('diagnostics')).toHaveLength(1);
  });

  it('getSlot은 frozen 복사본을 반환한다', () => {
    registerToSlot('hooks', {
      name: 'onGatewayStart',
      priority: 0,
      handler: async () => {},
      pluginName: 'test',
    });
    const hooks = getSlot('hooks');
    expect(Object.isFrozen(hooks)).toBe(true);
  });
});

describe('freezeRegistry', () => {
  it('freeze 후 registerToSlot은 RegistryFrozenError를 던진다', () => {
    freezeRegistry();
    expect(() =>
      registerToSlot('hooks', {
        name: 'onGatewayStart',
        priority: 0,
        handler: async () => {},
        pluginName: 'test',
      }),
    ).toThrow(RegistryFrozenError);
  });

  it('isRegistryFrozen이 상태를 반영한다', () => {
    expect(isRegistryFrozen()).toBe(false);
    freezeRegistry();
    expect(isRegistryFrozen()).toBe(true);
  });

  it('setPluginRegistry로 교체하면 frozen이 해제된다', () => {
    freezeRegistry();
    setPluginRegistry(createEmptyRegistry());
    expect(isRegistryFrozen()).toBe(false);
  });
});
