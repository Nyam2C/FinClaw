import { createChannelId } from '@finclaw/types';
// packages/server/test/channels/channel-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { createChannelDock } from '../../src/channels/dock.js';
import {
  registerChannelDock,
  getChannelDock,
  hasChannelDock,
  getAllChannelDocks,
  resetChannelRegistry,
} from '../../src/channels/registry.js';

const MINIMAL_CAPABILITIES = {
  supportsMarkdown: false,
  supportsImages: false,
  supportsAudio: false,
  supportsVideo: false,
  supportsButtons: false,
  supportsThreads: false,
  supportsReactions: false,
  supportsEditing: false,
  maxMessageLength: 1000,
} as const;

function makeDock(id: string) {
  return createChannelDock({
    id,
    meta: { name: id, displayName: id },
    capabilities: MINIMAL_CAPABILITIES,
  });
}

beforeEach(() => {
  resetChannelRegistry();
});

describe('registerChannelDock', () => {
  it('도크를 등록한다', () => {
    const dock = makeDock('test');
    registerChannelDock(dock);
    expect(hasChannelDock('test')).toBe(true);
  });

  it('중복 등록 시 에러를 던진다', () => {
    registerChannelDock(makeDock('dup'));
    expect(() => registerChannelDock(makeDock('dup'))).toThrow('already registered');
  });
});

describe('getChannelDock', () => {
  it('등록된 도크를 반환한다', () => {
    const dock = makeDock('alpha');
    registerChannelDock(dock);
    expect(getChannelDock('alpha')).toBe(dock);
  });

  it('ChannelId 브랜드 타입으로도 조회한다', () => {
    const dock = makeDock('branded');
    registerChannelDock(dock);
    const channelId = createChannelId('branded');
    expect(getChannelDock(channelId)).toBe(dock);
  });

  it('미등록 도크는 undefined를 반환한다', () => {
    expect(getChannelDock('nonexistent')).toBeUndefined();
  });
});

describe('hasChannelDock', () => {
  it('등록된 도크는 true', () => {
    registerChannelDock(makeDock('exists'));
    expect(hasChannelDock('exists')).toBe(true);
  });

  it('미등록 도크는 false', () => {
    expect(hasChannelDock('nope')).toBe(false);
  });
});

describe('getAllChannelDocks', () => {
  it('빈 레지스트리는 빈 배열을 반환한다', () => {
    expect(getAllChannelDocks()).toEqual([]);
  });

  it('등록된 모든 도크를 반환한다', () => {
    registerChannelDock(makeDock('a'));
    registerChannelDock(makeDock('b'));
    const all = getAllChannelDocks();
    expect(all).toHaveLength(2);
  });
});

describe('resetChannelRegistry', () => {
  it('레지스트리를 비운다', () => {
    registerChannelDock(makeDock('to-clear'));
    expect(getAllChannelDocks()).toHaveLength(1);
    resetChannelRegistry();
    expect(getAllChannelDocks()).toHaveLength(0);
  });
});
