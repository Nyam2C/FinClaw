# Phase 5 todo-c: 채널 레이어 + 통합 (세션 4-5)

> **소스 11 + 테스트 4 = 15파일**

## 선행조건

```bash
# todo-a + todo-b 완료 확인
pnpm typecheck                                 # 에러 0
pnpm vitest run packages/server/test/plugins/  # 7개 전체 통과
```

---

# 세션 4: Steps 5-6 — Channel Dock + Registry + ChatType + Gating + Typing (소스 9 + 테스트 4 = 13파일)

## 5-1. packages/server/src/channels/dock.ts 생성

**의존:** `@finclaw/types` (ChannelDock, ChannelCapabilities, OutboundLimits, ChannelMeta, ChannelId)

> createChannelDock() 팩토리 + CORE_DOCKS(discord, http-webhook).
> OpenClaw 정적 DOCKS Record 패턴. Object.freeze로 불변성 보장.

```typescript
// packages/server/src/channels/dock.ts
import type {
  ChannelDock,
  ChannelCapabilities,
  OutboundLimits,
  ChannelMeta,
  ChannelId,
} from '@finclaw/types';

const DEFAULT_CAPABILITIES: ChannelCapabilities = {
  supportsMarkdown: false,
  supportsImages: false,
  supportsAudio: false,
  supportsVideo: false,
  supportsButtons: false,
  supportsThreads: false,
  supportsReactions: false,
  supportsEditing: false,
  maxMessageLength: 2000,
};

const DEFAULT_LIMITS: OutboundLimits = {
  maxChunkLength: 2000,
  maxMediaPerMessage: 0,
  rateLimitPerMinute: 60,
};

/** ChannelDock 팩토리 — defaults 병합 + Object.freeze */
export function createChannelDock(params: {
  id: string;
  meta: ChannelMeta;
  capabilities?: Partial<ChannelCapabilities>;
  defaultChatType?: 'direct' | 'group';
  threadingMode?: 'none' | 'native' | 'emulated';
  outboundLimits?: Partial<OutboundLimits>;
}): Readonly<ChannelDock> {
  return Object.freeze({
    id: params.id as ChannelId,
    meta: params.meta,
    capabilities: { ...DEFAULT_CAPABILITIES, ...params.capabilities },
    defaultChatType: params.defaultChatType ?? 'group',
    threadingMode: params.threadingMode ?? 'none',
    outboundLimits: { ...DEFAULT_LIMITS, ...params.outboundLimits },
  });
}

/** 코어 채널 Dock 상수 (플러그인 로딩 없이 사용 가능) */
export const CORE_DOCKS: ReadonlyMap<string, ChannelDock> = new Map([
  [
    'discord',
    createChannelDock({
      id: 'discord',
      meta: { name: 'discord', displayName: 'Discord' },
      capabilities: {
        supportsThreads: true,
        supportsReactions: true,
        supportsEditing: true,
        supportsMarkdown: true,
        supportsImages: true,
        maxMessageLength: 2000,
      },
      defaultChatType: 'group',
      threadingMode: 'native',
      outboundLimits: {
        maxChunkLength: 2000,
        maxMediaPerMessage: 10,
        rateLimitPerMinute: 50,
      },
    }),
  ],
  [
    'http-webhook',
    createChannelDock({
      id: 'http-webhook',
      meta: { name: 'http-webhook', displayName: 'HTTP Webhook' },
      capabilities: { maxMessageLength: 65535 },
      defaultChatType: 'direct',
      threadingMode: 'none',
      outboundLimits: {
        maxChunkLength: 65535,
        maxMediaPerMessage: 0,
        rateLimitPerMinute: 100,
      },
    }),
  ],
]);
```

## 5-2. packages/server/src/channels/registry.ts 생성

**의존:** `@finclaw/types` (ChannelDock), `./dock.js` (CORE_DOCKS)

> 채널 등록/조회 레지스트리 — built-in CORE_DOCKS + 플러그인 Dock merge.

```typescript
// packages/server/src/channels/registry.ts
import type { ChannelDock } from '@finclaw/types';
import { CORE_DOCKS } from './dock.js';

const channelDocks = new Map<string, ChannelDock>(CORE_DOCKS);

/** 채널 Dock 등록 (플러그인이 추가 채널을 등록할 때 사용) */
export function registerChannelDock(dock: ChannelDock): void {
  channelDocks.set(dock.id as string, dock);
}

/** 채널 Dock 조회 */
export function getChannelDock(channelId: string): ChannelDock | undefined {
  return channelDocks.get(channelId);
}

/** 등록된 모든 채널 Dock 반환 */
export function getAllChannelDocks(): ReadonlyMap<string, ChannelDock> {
  return channelDocks;
}

/** 채널 존재 여부 */
export function hasChannelDock(channelId: string): boolean {
  return channelDocks.has(channelId);
}

/** 테스트용 레지스트리 초기화 (CORE_DOCKS로 복원) */
export function resetChannelRegistry(): void {
  channelDocks.clear();
  for (const [id, dock] of CORE_DOCKS) {
    channelDocks.set(id, dock);
  }
}
```

## 5-3. packages/server/src/channels/chat-type.ts 생성

**의존:** `@finclaw/types` (ChatType)

> 채널에서 수신한 원시 chatType 문자열을 3종 ChatType으로 정규화.

```typescript
// packages/server/src/channels/chat-type.ts
import type { ChatType } from '@finclaw/types';

/**
 * ChatType 정규화
 *
 * - 'dm', 'private' → 'direct'
 * - 'public' → 'channel'
 * - undefined/unknown → fallback (기본: 'group')
 */
export function normalizeChatType(raw: string | undefined, fallback: ChatType = 'group'): ChatType {
  switch (raw?.toLowerCase()) {
    case 'direct':
    case 'dm':
    case 'private':
      return 'direct';
    case 'group':
      return 'group';
    case 'channel':
    case 'public':
      return 'channel';
    default:
      return fallback;
  }
}

/** ChatType이 DM(1:1)인지 판별 */
export function isDirect(chatType: ChatType): boolean {
  return chatType === 'direct';
}

/** ChatType이 그룹/채널(다인)인지 판별 */
export function isMultiUser(chatType: ChatType): boolean {
  return chatType === 'group' || chatType === 'channel';
}
```

## 5-4. packages/server/src/channels/typing.ts 생성

**의존:** `@finclaw/types` (ChannelPlugin)

> 채널별 타이핑 인디케이터 관리. 타이머 기반 자동 갱신.

```typescript
// packages/server/src/channels/typing.ts
import type { ChannelPlugin } from '@finclaw/types';

const DEFAULT_TYPING_INTERVAL_MS = 5000;

interface TypingState {
  timer: ReturnType<typeof setInterval>;
  channelId: string;
  chatId: string;
}

const activeTyping = new Map<string, TypingState>();

/** 타이핑 인디케이터 시작 — intervalMs마다 sendTyping 호출 */
export function startTyping(
  plugin: Pick<ChannelPlugin, 'id' | 'sendTyping'>,
  chatId: string,
  intervalMs = DEFAULT_TYPING_INTERVAL_MS,
): void {
  const key = `${plugin.id as string}:${chatId}`;
  stopTyping(plugin, chatId);

  if (!plugin.sendTyping) return;

  // 즉시 한 번 실행
  plugin.sendTyping(plugin.id as string, chatId).catch(() => {});

  const timer = setInterval(() => {
    plugin.sendTyping!(plugin.id as string, chatId).catch(() => {});
  }, intervalMs);

  activeTyping.set(key, {
    timer,
    channelId: plugin.id as string,
    chatId,
  });
}

/** 타이핑 인디케이터 중지 */
export function stopTyping(plugin: Pick<ChannelPlugin, 'id'>, chatId: string): void {
  const key = `${plugin.id as string}:${chatId}`;
  const state = activeTyping.get(key);
  if (state) {
    clearInterval(state.timer);
    activeTyping.delete(key);
  }
}

/** 모든 타이핑 인디케이터 중지 (shutdown용) */
export function stopAllTyping(): void {
  for (const state of activeTyping.values()) {
    clearInterval(state.timer);
  }
  activeTyping.clear();
}

/** 활성 타이핑 수 (테스트 보조) */
export function activeTypingCount(): number {
  return activeTyping.size;
}
```

## 6-1. packages/server/src/channels/gating/pipeline.ts 생성

**의존:** `@finclaw/types` (InboundMessage, ChannelDock)

> composeGates(): 게이팅 함수를 순서대로 합성. 첫 번째 실패에서 early exit.

```typescript
// packages/server/src/channels/gating/pipeline.ts
import type { InboundMessage, ChannelDock } from '@finclaw/types';

/** 게이팅 결과 */
export type GatingResult = { allowed: true } | { allowed: false; reason: string };

/** 게이팅 컨텍스트 */
export interface GatingContext {
  botUserId: string;
  commandPrefix: string | null;
}

/** 게이팅 함수 시그니처 */
export type GateFunction = (
  msg: InboundMessage,
  dock: ChannelDock,
  ctx: GatingContext,
) => GatingResult;

/**
 * 게이팅 함수 합성 — 순서대로 실행, 첫 실패에서 early exit.
 * 모든 게이트 통과 시 { allowed: true } 반환.
 */
export function composeGates(...gates: GateFunction[]): GateFunction {
  return (msg, dock, ctx) => {
    for (const gate of gates) {
      const result = gate(msg, dock, ctx);
      if (!result.allowed) return result;
    }
    return { allowed: true };
  };
}
```

## 6-2. packages/server/src/channels/gating/mention-gating.ts 생성

**의존:** `./pipeline.js` (GateFunction)

> 그룹/채널에서 봇 멘션이 있을 때만 허용. DM은 항상 바이패스.

```typescript
// packages/server/src/channels/gating/mention-gating.ts
import type { GateFunction } from './pipeline.js';

/**
 * 멘션 기반 게이팅
 *
 * - DM(direct)은 항상 허용 (멘션 불필요)
 * - 그룹/채널에서는 봇 userId가 body에 포함되어야 허용
 */
export const mentionGate: GateFunction = (msg, _dock, ctx) => {
  // DM 바이패스
  if (msg.chatType === 'direct') {
    return { allowed: true };
  }

  // 그룹/채널: 봇 멘션 확인
  if (msg.body.includes(ctx.botUserId)) {
    return { allowed: true };
  }

  return { allowed: false, reason: 'Bot not mentioned in group message' };
};
```

## 6-3. packages/server/src/channels/gating/command-gating.ts 생성

**의존:** `./pipeline.js` (GateFunction)

> 커맨드 접두사로 시작하는 메시지만 허용. prefix가 null이면 게이트 비활성.

```typescript
// packages/server/src/channels/gating/command-gating.ts
import type { GateFunction } from './pipeline.js';

/**
 * 커맨드 게이팅
 *
 * - commandPrefix가 null이면 항상 허용 (게이트 비활성)
 * - body가 commandPrefix로 시작하면 허용
 */
export const commandGate: GateFunction = (msg, _dock, ctx) => {
  if (ctx.commandPrefix === null) {
    return { allowed: true };
  }

  if (msg.body.startsWith(ctx.commandPrefix)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Message does not start with command prefix '${ctx.commandPrefix}'`,
  };
};
```

## 6-4. packages/server/src/channels/gating/allowlist.ts 생성

**의존:** `./pipeline.js` (GateFunction, GatingResult)

> 화이트리스트 매칭 — 허용 목록에 포함된 senderId만 통과.

```typescript
// packages/server/src/channels/gating/allowlist.ts
import type { InboundMessage, ChannelDock } from '@finclaw/types';
import type { GatingResult, GatingContext } from './pipeline.js';

/**
 * 허용 목록 게이팅 팩토리
 *
 * - allowlist가 비어있으면 모든 사용자 허용
 * - allowlist에 senderId가 포함되면 허용
 */
export function createAllowlistGate(
  allowlist: ReadonlySet<string>,
): (msg: InboundMessage, dock: ChannelDock, ctx: GatingContext) => GatingResult {
  return (msg) => {
    if (allowlist.size === 0) {
      return { allowed: true };
    }

    if (allowlist.has(msg.senderId)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Sender '${msg.senderId}' not in allowlist`,
    };
  };
}
```

## 5-5. packages/server/test/channels/dock.test.ts 생성

**의존:** `../../src/channels/dock.js`

```typescript
// packages/server/test/channels/dock.test.ts
import { describe, it, expect } from 'vitest';
import { createChannelDock, CORE_DOCKS } from '../../src/channels/dock.js';

describe('createChannelDock', () => {
  it('기본값이 적용된 ChannelDock을 생성한다', () => {
    const dock = createChannelDock({
      id: 'test',
      meta: { name: 'test', displayName: 'Test' },
    });

    expect(dock.id).toBe('test');
    expect(dock.meta.displayName).toBe('Test');
    expect(dock.defaultChatType).toBe('group');
    expect(dock.threadingMode).toBe('none');
    expect(dock.capabilities.supportsMarkdown).toBe(false);
    expect(dock.capabilities.maxMessageLength).toBe(2000);
    expect(dock.outboundLimits.rateLimitPerMinute).toBe(60);
  });

  it('capabilities 부분 오버라이드가 가능하다', () => {
    const dock = createChannelDock({
      id: 'custom',
      meta: { name: 'custom', displayName: 'Custom' },
      capabilities: { supportsMarkdown: true, maxMessageLength: 4000 },
    });

    expect(dock.capabilities.supportsMarkdown).toBe(true);
    expect(dock.capabilities.maxMessageLength).toBe(4000);
    // 나머지는 기본값
    expect(dock.capabilities.supportsImages).toBe(false);
  });

  it('outboundLimits 부분 오버라이드가 가능하다', () => {
    const dock = createChannelDock({
      id: 'custom',
      meta: { name: 'custom', displayName: 'Custom' },
      outboundLimits: { rateLimitPerMinute: 100 },
    });

    expect(dock.outboundLimits.rateLimitPerMinute).toBe(100);
    expect(dock.outboundLimits.maxChunkLength).toBe(2000); // 기본값
  });

  it('Object.freeze로 불변이다', () => {
    const dock = createChannelDock({
      id: 'frozen',
      meta: { name: 'frozen', displayName: 'Frozen' },
    });

    expect(Object.isFrozen(dock)).toBe(true);
  });
});

describe('CORE_DOCKS', () => {
  it('discord와 http-webhook 2개가 등록되어 있다', () => {
    expect(CORE_DOCKS.size).toBe(2);
    expect(CORE_DOCKS.has('discord')).toBe(true);
    expect(CORE_DOCKS.has('http-webhook')).toBe(true);
  });

  it('discord Dock의 capabilities가 올바르다', () => {
    const discord = CORE_DOCKS.get('discord')!;
    expect(discord.capabilities.supportsThreads).toBe(true);
    expect(discord.capabilities.supportsReactions).toBe(true);
    expect(discord.capabilities.supportsMarkdown).toBe(true);
    expect(discord.capabilities.maxMessageLength).toBe(2000);
    expect(discord.threadingMode).toBe('native');
    expect(discord.defaultChatType).toBe('group');
  });

  it('http-webhook Dock의 capabilities가 올바르다', () => {
    const webhook = CORE_DOCKS.get('http-webhook')!;
    expect(webhook.capabilities.maxMessageLength).toBe(65535);
    expect(webhook.threadingMode).toBe('none');
    expect(webhook.defaultChatType).toBe('direct');
    expect(webhook.outboundLimits.rateLimitPerMinute).toBe(100);
  });

  it('ReadonlyMap이다', () => {
    // Map 메서드는 존재하지만 set은 타입 에러 (ReadonlyMap)
    expect(typeof CORE_DOCKS.get).toBe('function');
    expect(typeof CORE_DOCKS.has).toBe('function');
  });
});
```

## 5-6. packages/server/test/channels/chat-type.test.ts 생성

**의존:** `../../src/channels/chat-type.js`

```typescript
// packages/server/test/channels/chat-type.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeChatType, isDirect, isMultiUser } from '../../src/channels/chat-type.js';

describe('normalizeChatType', () => {
  it('"direct"를 direct로 정규화한다', () => {
    expect(normalizeChatType('direct')).toBe('direct');
  });

  it('"dm"을 direct로 정규화한다', () => {
    expect(normalizeChatType('dm')).toBe('direct');
  });

  it('"DM"을 direct로 정규화한다 (대소문자 무시)', () => {
    expect(normalizeChatType('DM')).toBe('direct');
  });

  it('"private"을 direct로 정규화한다', () => {
    expect(normalizeChatType('private')).toBe('direct');
  });

  it('"group"을 group으로 정규화한다', () => {
    expect(normalizeChatType('group')).toBe('group');
  });

  it('"channel"을 channel로 정규화한다', () => {
    expect(normalizeChatType('channel')).toBe('channel');
  });

  it('"public"을 channel로 정규화한다', () => {
    expect(normalizeChatType('public')).toBe('channel');
  });

  it('undefined에 fallback을 반환한다', () => {
    expect(normalizeChatType(undefined)).toBe('group');
    expect(normalizeChatType(undefined, 'direct')).toBe('direct');
  });

  it('알 수 없는 값에 fallback을 반환한다', () => {
    expect(normalizeChatType('unknown')).toBe('group');
  });
});

describe('isDirect', () => {
  it('direct일 때 true', () => expect(isDirect('direct')).toBe(true));
  it('group일 때 false', () => expect(isDirect('group')).toBe(false));
  it('channel일 때 false', () => expect(isDirect('channel')).toBe(false));
});

describe('isMultiUser', () => {
  it('group일 때 true', () => expect(isMultiUser('group')).toBe(true));
  it('channel일 때 true', () => expect(isMultiUser('channel')).toBe(true));
  it('direct일 때 false', () => expect(isMultiUser('direct')).toBe(false));
});
```

## 6-5. packages/server/test/channels/gating.test.ts 생성

**의존:** `../../src/channels/gating/*.js`

```typescript
// packages/server/test/channels/gating.test.ts
import { describe, it, expect } from 'vitest';
import type { InboundMessage, ChannelDock } from '@finclaw/types';
import { createChannelId, createTimestamp } from '@finclaw/types';
import { composeGates, type GatingContext } from '../../src/channels/gating/pipeline.js';
import { mentionGate } from '../../src/channels/gating/mention-gating.js';
import { commandGate } from '../../src/channels/gating/command-gating.js';
import { createAllowlistGate } from '../../src/channels/gating/allowlist.js';
import { CORE_DOCKS } from '../../src/channels/dock.js';

const discordDock = CORE_DOCKS.get('discord')!;

function makeMsg(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    id: 'msg-1',
    channelId: createChannelId('discord'),
    chatType: 'group',
    senderId: 'user1',
    body: 'hello',
    timestamp: createTimestamp(Date.now()),
    ...overrides,
  };
}

const defaultCtx: GatingContext = {
  botUserId: 'bot-123',
  commandPrefix: '!',
};

describe('mentionGate', () => {
  it('DM은 항상 허용한다', () => {
    const msg = makeMsg({ chatType: 'direct', body: 'hello' });
    const result = mentionGate(msg, discordDock, defaultCtx);
    expect(result.allowed).toBe(true);
  });

  it('그룹에서 봇 멘션이 있으면 허용한다', () => {
    const msg = makeMsg({ body: 'hey bot-123 do something' });
    const result = mentionGate(msg, discordDock, defaultCtx);
    expect(result.allowed).toBe(true);
  });

  it('그룹에서 봇 멘션이 없으면 거부한다', () => {
    const msg = makeMsg({ body: 'hello everyone' });
    const result = mentionGate(msg, discordDock, defaultCtx);
    expect(result.allowed).toBe(false);
  });
});

describe('commandGate', () => {
  it('commandPrefix가 null이면 항상 허용한다', () => {
    const ctx = { ...defaultCtx, commandPrefix: null };
    const result = commandGate(makeMsg(), discordDock, ctx);
    expect(result.allowed).toBe(true);
  });

  it('body가 접두사로 시작하면 허용한다', () => {
    const msg = makeMsg({ body: '!help' });
    const result = commandGate(msg, discordDock, defaultCtx);
    expect(result.allowed).toBe(true);
  });

  it('body가 접두사로 시작하지 않으면 거부한다', () => {
    const msg = makeMsg({ body: 'hello' });
    const result = commandGate(msg, discordDock, defaultCtx);
    expect(result.allowed).toBe(false);
  });
});

describe('createAllowlistGate', () => {
  it('빈 allowlist이면 모든 사용자를 허용한다', () => {
    const gate = createAllowlistGate(new Set());
    const result = gate(makeMsg(), discordDock, defaultCtx);
    expect(result.allowed).toBe(true);
  });

  it('allowlist에 포함된 senderId를 허용한다', () => {
    const gate = createAllowlistGate(new Set(['user1', 'user2']));
    const result = gate(makeMsg({ senderId: 'user1' }), discordDock, defaultCtx);
    expect(result.allowed).toBe(true);
  });

  it('allowlist에 없는 senderId를 거부한다', () => {
    const gate = createAllowlistGate(new Set(['user1']));
    const result = gate(makeMsg({ senderId: 'user3' }), discordDock, defaultCtx);
    expect(result.allowed).toBe(false);
  });
});

describe('composeGates', () => {
  it('모든 게이트 통과 시 allowed: true', () => {
    const gate = composeGates(
      () => ({ allowed: true }),
      () => ({ allowed: true }),
    );
    const result = gate(makeMsg(), discordDock, defaultCtx);
    expect(result.allowed).toBe(true);
  });

  it('첫 번째 실패에서 early exit한다', () => {
    let secondCalled = false;
    const gate = composeGates(
      () => ({ allowed: false, reason: 'first fail' }),
      () => {
        secondCalled = true;
        return { allowed: true };
      },
    );

    const result = gate(makeMsg(), discordDock, defaultCtx);
    expect(result.allowed).toBe(false);
    if (!result.allowed) {
      expect(result.reason).toBe('first fail');
    }
    expect(secondCalled).toBe(false);
  });

  it('게이트가 없으면 항상 허용한다', () => {
    const gate = composeGates();
    const result = gate(makeMsg(), discordDock, defaultCtx);
    expect(result.allowed).toBe(true);
  });

  it('mentionGate + commandGate 조합 테스트', () => {
    const gate = composeGates(mentionGate, commandGate);

    // DM + 커맨드 접두사 → 허용
    const dm = makeMsg({ chatType: 'direct', body: '!help' });
    expect(gate(dm, discordDock, defaultCtx).allowed).toBe(true);

    // 그룹 + 멘션 + 커맨드 → 허용
    const mentioned = makeMsg({ body: '!help bot-123' });
    expect(gate(mentioned, discordDock, defaultCtx).allowed).toBe(false);
    // 멘션이 body에 포함되어야 하므로 수정:
    const mentionedCmd = makeMsg({ body: 'bot-123 !help' });
    // mentionGate 통과 (bot-123 포함), commandGate 실패 (!로 시작하지 않음)
    expect(gate(mentionedCmd, discordDock, defaultCtx).allowed).toBe(false);

    // 그룹 + 멘션 없음 → mentionGate에서 거부
    const noMention = makeMsg({ body: '!help' });
    expect(gate(noMention, discordDock, defaultCtx).allowed).toBe(false);
  });
});
```

## 5-7. packages/server/test/channels/channel-registry.test.ts 생성

**의존:** `../../src/channels/registry.js`, `../../src/channels/dock.js`

```typescript
// packages/server/test/channels/channel-registry.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  registerChannelDock,
  getChannelDock,
  getAllChannelDocks,
  hasChannelDock,
  resetChannelRegistry,
} from '../../src/channels/registry.js';
import { createChannelDock } from '../../src/channels/dock.js';

beforeEach(() => {
  resetChannelRegistry();
});

describe('채널 레지스트리', () => {
  it('CORE_DOCKS(discord, http-webhook)가 초기 등록되어 있다', () => {
    expect(hasChannelDock('discord')).toBe(true);
    expect(hasChannelDock('http-webhook')).toBe(true);
  });

  it('getChannelDock으로 등록된 Dock을 조회한다', () => {
    const discord = getChannelDock('discord');
    expect(discord).toBeDefined();
    expect(discord!.meta.displayName).toBe('Discord');
  });

  it('미등록 channelId에 undefined를 반환한다', () => {
    expect(getChannelDock('slack')).toBeUndefined();
  });

  it('registerChannelDock으로 새 채널을 추가한다', () => {
    const slack = createChannelDock({
      id: 'slack',
      meta: { name: 'slack', displayName: 'Slack' },
      capabilities: { supportsThreads: true },
    });
    registerChannelDock(slack);

    expect(hasChannelDock('slack')).toBe(true);
    expect(getChannelDock('slack')!.meta.displayName).toBe('Slack');
  });

  it('getAllChannelDocks가 전체 Map을 반환한다', () => {
    const all = getAllChannelDocks();
    expect(all.size).toBeGreaterThanOrEqual(2); // discord + http-webhook
  });

  it('resetChannelRegistry가 CORE_DOCKS로 복원한다', () => {
    registerChannelDock(
      createChannelDock({
        id: 'custom',
        meta: { name: 'custom', displayName: 'Custom' },
      }),
    );
    expect(hasChannelDock('custom')).toBe(true);

    resetChannelRegistry();
    expect(hasChannelDock('custom')).toBe(false);
    expect(hasChannelDock('discord')).toBe(true);
  });
});
```

---

# 세션 5: Step 7 — Barrel Export + Event Bridge (소스 3 = 3파일)

## 7-1. packages/server/src/channels/index.ts 생성

**의존:** 세션 4 채널 소스 전체

```typescript
// packages/server/src/channels/index.ts

// Dock
export { createChannelDock, CORE_DOCKS } from './dock.js';

// Registry
export {
  registerChannelDock,
  getChannelDock,
  getAllChannelDocks,
  hasChannelDock,
  resetChannelRegistry,
} from './registry.js';

// ChatType
export { normalizeChatType, isDirect, isMultiUser } from './chat-type.js';

// Typing
export { startTyping, stopTyping, stopAllTyping, activeTypingCount } from './typing.js';

// Gating
export {
  composeGates,
  type GatingResult,
  type GateFunction,
  type GatingContext,
} from './gating/pipeline.js';
export { mentionGate } from './gating/mention-gating.js';
export { commandGate } from './gating/command-gating.js';
export { createAllowlistGate } from './gating/allowlist.js';
```

## 7-2. packages/server/src/plugins/index.ts 생성

**의존:** 세션 1-3 플러그인 소스 전체

```typescript
// packages/server/src/plugins/index.ts

// Errors
export { PluginLoadError, PluginSecurityError, RegistryFrozenError } from './errors.js';

// Hook Types
export type { HookPayloadMap, HookModeMap } from './hook-types.js';

// Registry
export {
  createEmptyRegistry,
  getPluginRegistry,
  setPluginRegistry,
  freezeRegistry,
  isRegistryFrozen,
  registerToSlot,
  getSlot,
  type SlotName,
} from './registry.js';

// Hooks
export {
  createHookRunner,
  type HookMode,
  type HookTapOptions,
  type VoidHookRunner,
  type ModifyingHookRunner,
  type SyncHookRunner,
} from './hooks.js';

// Manifest
export { PluginManifestSchema, parseManifest, manifestJsonSchema } from './manifest.js';

// Discovery
export {
  discoverPlugins,
  validatePluginPath,
  isAllowedExtension,
  type DiscoveredPlugin,
} from './discovery.js';

// Loader
export {
  loadPlugins,
  createPluginBuildApi,
  type PluginExports,
  type PluginBuildApi,
  type LoadResult,
} from './loader.js';

// Event Bridge
export { bridgeHookToEvent } from './event-bridge.js';
```

## 7-3. packages/server/src/plugins/event-bridge.ts 생성

**의존:** `@finclaw/infra` (getEventBus)

> Hook → EventBus 단방향 브릿지. void 훅 실행 후 호출하여 매핑된 이벤트 전파.
> modifying 훅의 변형 결과는 브릿지하지 않음.

```typescript
// packages/server/src/plugins/event-bridge.ts
import { getEventBus } from '@finclaw/infra';

/**
 * Hook → EventBus 단방향 브릿지
 *
 * void 훅 fire 완료 후 호출하여 EventBus에 매핑된 이벤트를 전파한다.
 * modifying 훅의 변형 결과는 브릿지하지 않는다.
 *
 * 매핑:
 *   onConfigChange  → config:change(changedPaths)
 *   onGatewayStart  → system:ready()
 *   onGatewayStop   → system:shutdown(reason)
 */
export function bridgeHookToEvent(hookName: string, payload: unknown): void {
  const bus = getEventBus();

  switch (hookName) {
    case 'onConfigChange': {
      const p = payload as { changedPaths: string[] };
      bus.emit('config:change', p.changedPaths);
      break;
    }
    case 'onGatewayStart':
      bus.emit('system:ready');
      break;
    case 'onGatewayStop':
      bus.emit('system:shutdown', 'gateway-stop');
      break;
    default:
      break; // 매핑 없는 훅은 브릿지하지 않음
  }
}
```

### 세션 5 완료 검증

```bash
pnpm typecheck  # 에러 0
```

---

## 전체 검증 (todo-c 완료 후)

```bash
pnpm typecheck                                                          # 에러 0
pnpm lint                                                               # 경고/에러 0
pnpm vitest run packages/server/test/plugins/                           # 7개 전체 통과
pnpm vitest run packages/server/test/channels/                          # 4개 전체 통과
pnpm vitest run packages/server/test/plugins/ packages/server/test/channels/  # 11개 전체 통과
pnpm build                                                              # 빌드 성공
```

---

## 의존성 그래프

```
todo-a 산출물 (types, errors, registry, hooks)
todo-b 산출물 (manifest, discovery, loader)
       │
       ▼
5-1 dock.ts ──────┬──→ 5-5 dock.test.ts
                  │
5-2 registry.ts ──┤──→ 5-7 channel-registry.test.ts
                  │
5-3 chat-type.ts ─┤──→ 5-6 chat-type.test.ts
                  │
5-4 typing.ts ────┘
                  │
6-1 pipeline.ts ──┬──→ 6-5 gating.test.ts
6-2 mention.ts ───┤
6-3 command.ts ───┤
6-4 allowlist.ts ─┘
                  │
7-1 channels/index.ts ─── barrel
7-2 plugins/index.ts ──── barrel
7-3 event-bridge.ts ───── Hook → EventBus
```
