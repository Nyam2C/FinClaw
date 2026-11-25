// packages/server/test/channels/channel-registry.test.ts
// 레지스트리는 모듈 싱글턴 — 테스트마다 고유 id 사용.
import { describe, it, expect } from 'vitest';
import { createChannelDock } from '../../src/channels/dock.js';
import { registerChannelDock, getAllChannelDocks } from '../../src/channels/registry.js';

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

describe('registerChannelDock / getAllChannelDocks', () => {
  it('도크를 등록하면 목록에 포함된다', () => {
    const dock = makeDock('alpha');
    registerChannelDock(dock);
    expect(getAllChannelDocks()).toContain(dock);
  });

  it('중복 등록 시 에러를 던진다', () => {
    registerChannelDock(makeDock('dup'));
    expect(() => registerChannelDock(makeDock('dup'))).toThrow('already registered');
  });

  it('여러 도크를 모두 반환한다', () => {
    registerChannelDock(makeDock('a'));
    registerChannelDock(makeDock('b'));
    const ids = getAllChannelDocks().map((d) => d.id as string);
    expect(ids).toEqual(expect.arrayContaining(['a', 'b']));
  });
});
