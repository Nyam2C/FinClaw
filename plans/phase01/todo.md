# Phase 1 상세 구현 TODO

> 현재 소스 분석 기준: 2026-02-25
> 대상 패키지: `packages/types/`
> 잔여 작업 7개, 변경 대상 파일 4개 + 신규 파일 5개

---

## T1. `common.ts` L32-33: `AsyncDisposable` → `CleanupFn` 리네이밍

### 왜

TC39 Stage 3 `Symbol.asyncDispose`가 Node.js 22에 내장되어, `AsyncDisposable`은
전역 인터페이스 `AsyncDisposable`과 이름 충돌 위험이 있다. `CleanupFn`으로 리네이밍하여
미래 호환성을 확보한다.

### 무엇을 — `packages/types/src/common.ts` L32-33

**Before:**

```typescript
/** 비동기 정리 함수 */
export type AsyncDisposable = () => Promise<void>;
```

**After:**

```typescript
/**
 * 비동기 정리 함수 -- TC39 `Symbol.asyncDispose`와 이름 충돌 방지를 위해
 * `AsyncDisposable` 대신 `CleanupFn`으로 명명.
 */
export type CleanupFn = () => Promise<void>;
```

### 검증

- `AsyncDisposable`에 대한 참조가 코드베이스에 남아있지 않음 (T4에서 `channel.ts` 반영)
- `pnpm typecheck` 통과

---

## T2. `common.ts` L36 뒤: `ErrorReason` + `FinClawError` 추가

### 왜

시스템 전역 에러 분류(`ErrorReason`)와 구조화된 에러 인터페이스(`FinClawError`)가 필요하다.
`Result<T, FinClawError>` 패턴으로 명시적 에러 전파를 가능하게 한다 (plan.md §5.5).

### 무엇을 — `packages/types/src/common.ts` L36 뒤에 삽입

현재 L36: `export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';`

**삽입할 코드:**

```typescript
// ─── 에러 타입 ───

/** 에러 분류 -- FinClaw 시스템 전역에서 사용 */
export type ErrorReason =
  | 'CONFIG_INVALID' // 설정 파싱/검증 실패
  | 'CHANNEL_OFFLINE' // 채널 연결 불가
  | 'AGENT_TIMEOUT' // 에이전트 응답 초과
  | 'STORAGE_FAILURE' // 스토리지 읽기/쓰기 실패
  | 'RATE_LIMITED' // 외부 API 속도 제한
  | 'AUTH_FAILURE' // 인증/인가 실패
  | 'INTERNAL'; // 분류 불가 내부 에러

/** 구조화된 에러 인터페이스 */
export interface FinClawError {
  reason: ErrorReason;
  message: string;
  cause?: unknown;
  timestamp: Timestamp;
}
```

### 검증

- `Timestamp` (L21)이 이미 정의되어 있으므로 추가 import 불필요
- `pnpm typecheck` 통과

---

## T3. `config.ts` L162 뒤: `ConfigIoDeps` 추가

### 왜

설정 파일 I/O를 추상화하는 DI 인터페이스. OpenClaw `ConfigIoDeps`의 축소판으로,
테스트 시 파일시스템을 모킹할 수 있게 한다 (plan.md §4.2).

### 무엇을 — `packages/types/src/config.ts` L162 뒤에 삽입

현재 L157-163:

```typescript
/** 설정 변경 이벤트 */
export type ConfigChangeEvent = {
  previous: FinClawConfig;
  current: FinClawConfig;
  changedPaths: string[];
};
```

L163 (`};`) 뒤에 삽입:

```typescript
/** 설정 I/O 의존성 -- OpenClaw ConfigIoDeps 축소판 (DI용) */
export interface ConfigIoDeps {
  /** 설정 파일 읽기 */
  readFile(path: string): Promise<string>;
  /** 설정 파일 쓰기 */
  writeFile(path: string, content: string): Promise<void>;
  /** 파일 존재 여부 확인 */
  exists(path: string): Promise<boolean>;
  /** 환경 변수 조회 */
  env(key: string): string | undefined;
  /** 로그 출력 */
  log(level: LogLevel, message: string): void;
}
```

> `LogLevel`은 이미 L1에서 `import type { LogLevel } from './common.js'`로 import되어 있으므로
> 추가 import 불필요. plan.md §4.2의 `import('./common.js').LogLevel` 인라인 import 대신
> 직접 참조를 사용한다 (더 단순함).

### 검증

- `pnpm typecheck` 통과
- `ConfigIoDeps`가 `@finclaw/types`에서 import 가능 (T5 barrel export 후)

---

## T4. `channel.ts`: `CleanupFn` 반영

### 왜

T1에서 `AsyncDisposable` → `CleanupFn` 리네이밍 후, `channel.ts`의 import와
타입 참조를 일치시켜야 한다.

### 무엇을 — `packages/types/src/channel.ts` L1, L10, L11

**L1 Before:**

```typescript
import type { ChannelId, AsyncDisposable } from './common.js';
```

**L1 After:**

```typescript
import type { ChannelId, CleanupFn } from './common.js';
```

**L10 Before:**

```typescript
  setup?(config: TAccount): Promise<AsyncDisposable>;
```

**L10 After:**

```typescript
  setup?(config: TAccount): Promise<CleanupFn>;
```

**L11 Before:**

```typescript
  onMessage?(handler: (msg: InboundMessage) => Promise<void>): AsyncDisposable;
```

**L11 After:**

```typescript
  onMessage?(handler: (msg: InboundMessage) => Promise<void>): CleanupFn;
```

### 검증

- `grep -r "AsyncDisposable" packages/types/` 결과 0건
- `pnpm typecheck` 통과

---

## T5. `index.ts`: barrel export 구현

### 왜

현재 `index.ts`는 스텁 (`export type TODO = 'stub'`). 모든 외부 패키지가
`@finclaw/types`에서 타입을 import하려면 barrel export가 필요하다 (plan.md §5.1).

### 무엇을 — `packages/types/src/index.ts` 전체 교체

**Before (전체):**

```typescript
// @finclaw/types — shared type definitions
export type TODO = 'stub';
```

**After (전체):**

```typescript
// @finclaw/types — barrel export
export type * from './common.js';
export type * from './config.js';
export type * from './message.js';
export type * from './agent.js';
export type * from './channel.js';
export type * from './skill.js';
export type * from './storage.js';
export type * from './plugin.js';
export type * from './gateway.js';
export type * from './finance.js';

// 런타임 값 (const enum 대체)
export { RPC_ERROR_CODES } from './gateway.js';

// 브랜드 팩토리 함수
export { createTimestamp, createSessionKey, createAgentId, createChannelId } from './common.js';

export { createTickerSymbol, createCurrencyCode } from './finance.js';
```

> **폴백:** `export type *` 구문이 tsgo에서 문제를 일으킬 경우, 각 모듈에서
> 명시적으로 named re-export한다 (plan.md §5.1 폴백 참조).

### 검증

- `pnpm typecheck` 통과
- `pnpm build` 후 `dist/index.d.ts`에 모든 타입이 re-export됨
- 다른 패키지에서 `import type { FinClawConfig } from '@finclaw/types'` 가능

---

## T6. 테스트 4개 작성

### 왜

타입 패키지의 구조적 정합성과 런타임 팩토리 함수의 동작을 검증한다.
기존 `sample.test.ts`는 Phase 0 scaffold로 유지한다.

### T6-1. `packages/types/test/config.test.ts` (신규)

설정 타입의 구조적 호환성, 필수 필드 검증.

```typescript
import { describe, it, expect, expectTypeOf } from 'vitest';
import type {
  FinClawConfig,
  ConfigFileSnapshot,
  ConfigChangeEvent,
  ConfigIoDeps,
  ConfigValidationIssue,
} from '@finclaw/types';

describe('FinClawConfig', () => {
  it('빈 객체가 유효한 FinClawConfig이다 (모든 필드 optional)', () => {
    const config: FinClawConfig = {};
    expectTypeOf(config).toMatchTypeOf<FinClawConfig>();
  });

  it('gateway, agents, channels 등 최상위 필드를 가질 수 있다', () => {
    const config: FinClawConfig = {
      gateway: { port: 18789, host: 'localhost' },
      logging: { level: 'info' },
      finance: { dataProviders: [] },
    };
    expectTypeOf(config).toMatchTypeOf<FinClawConfig>();
  });
});

describe('ConfigFileSnapshot', () => {
  it('필수 필드를 갖는다', () => {
    expectTypeOf<ConfigFileSnapshot>().toHaveProperty('path');
    expectTypeOf<ConfigFileSnapshot>().toHaveProperty('exists');
    expectTypeOf<ConfigFileSnapshot>().toHaveProperty('valid');
    expectTypeOf<ConfigFileSnapshot>().toHaveProperty('config');
    expectTypeOf<ConfigFileSnapshot>().toHaveProperty('issues');
  });
});

describe('ConfigChangeEvent', () => {
  it('previous, current, changedPaths 필드를 갖는다', () => {
    expectTypeOf<ConfigChangeEvent>().toHaveProperty('previous');
    expectTypeOf<ConfigChangeEvent>().toHaveProperty('current');
    expectTypeOf<ConfigChangeEvent>().toHaveProperty('changedPaths');
  });
});

describe('ConfigIoDeps', () => {
  it('5개 메서드를 정의한다', () => {
    expectTypeOf<ConfigIoDeps>().toHaveProperty('readFile');
    expectTypeOf<ConfigIoDeps>().toHaveProperty('writeFile');
    expectTypeOf<ConfigIoDeps>().toHaveProperty('exists');
    expectTypeOf<ConfigIoDeps>().toHaveProperty('env');
    expectTypeOf<ConfigIoDeps>().toHaveProperty('log');
  });
});

describe('ConfigValidationIssue', () => {
  it('severity가 error 또는 warning이다', () => {
    const issue: ConfigValidationIssue = {
      path: 'gateway.port',
      message: 'Invalid port',
      severity: 'error',
    };
    expect(['error', 'warning']).toContain(issue.severity);
  });
});
```

### T6-2. `packages/types/test/message.test.ts` (신규)

메시지 타입의 ChatType 열거형, MsgContext 필드 검증.

```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type {
  ChatType,
  InboundMessage,
  MsgContext,
  ReplyPayload,
  OutboundMessage,
  GetReplyOptions,
  MediaAttachment,
} from '@finclaw/types';

describe('ChatType', () => {
  it('direct, group, channel 중 하나이다', () => {
    expectTypeOf<'direct'>().toMatchTypeOf<ChatType>();
    expectTypeOf<'group'>().toMatchTypeOf<ChatType>();
    expectTypeOf<'channel'>().toMatchTypeOf<ChatType>();
  });

  it('정의되지 않은 값은 할당 불가하다', () => {
    expectTypeOf<'unknown'>().not.toMatchTypeOf<ChatType>();
  });
});

describe('InboundMessage', () => {
  it('필수 필드를 갖는다', () => {
    expectTypeOf<InboundMessage>().toHaveProperty('id');
    expectTypeOf<InboundMessage>().toHaveProperty('channelId');
    expectTypeOf<InboundMessage>().toHaveProperty('chatType');
    expectTypeOf<InboundMessage>().toHaveProperty('senderId');
    expectTypeOf<InboundMessage>().toHaveProperty('body');
    expectTypeOf<InboundMessage>().toHaveProperty('timestamp');
  });
});

describe('MsgContext', () => {
  it('본문 계열 필드를 갖는다', () => {
    expectTypeOf<MsgContext>().toHaveProperty('body');
    expectTypeOf<MsgContext>().toHaveProperty('bodyForAgent');
    expectTypeOf<MsgContext>().toHaveProperty('rawBody');
  });

  it('발신자 계열 필드를 갖는다', () => {
    expectTypeOf<MsgContext>().toHaveProperty('from');
    expectTypeOf<MsgContext>().toHaveProperty('senderId');
    expectTypeOf<MsgContext>().toHaveProperty('senderName');
  });

  it('채널/세션 계열 필드를 갖는다', () => {
    expectTypeOf<MsgContext>().toHaveProperty('provider');
    expectTypeOf<MsgContext>().toHaveProperty('channelId');
    expectTypeOf<MsgContext>().toHaveProperty('sessionKey');
  });
});

describe('ReplyPayload', () => {
  it('모든 필드가 optional이다', () => {
    const empty: ReplyPayload = {};
    expectTypeOf(empty).toMatchTypeOf<ReplyPayload>();
  });
});

describe('OutboundMessage', () => {
  it('필수 필드를 갖는다', () => {
    expectTypeOf<OutboundMessage>().toHaveProperty('channelId');
    expectTypeOf<OutboundMessage>().toHaveProperty('targetId');
    expectTypeOf<OutboundMessage>().toHaveProperty('payloads');
  });
});

describe('MediaAttachment', () => {
  it('type이 4가지 중 하나이다', () => {
    expectTypeOf<'image'>().toMatchTypeOf<MediaAttachment['type']>();
    expectTypeOf<'audio'>().toMatchTypeOf<MediaAttachment['type']>();
    expectTypeOf<'video'>().toMatchTypeOf<MediaAttachment['type']>();
    expectTypeOf<'document'>().toMatchTypeOf<MediaAttachment['type']>();
  });
});

describe('GetReplyOptions', () => {
  it('runId가 필수이다', () => {
    expectTypeOf<GetReplyOptions>().toHaveProperty('runId');
  });
});
```

### T6-3. `packages/types/test/finance.test.ts` (신규)

금융 도메인 브랜드 타입 팩토리 함수의 런타임 동작 검증.

```typescript
import { describe, it, expect } from 'vitest';
import { createTickerSymbol, createCurrencyCode } from '@finclaw/types';

describe('createTickerSymbol', () => {
  it('대문자로 정규화한다', () => {
    const symbol = createTickerSymbol('aapl');
    expect(symbol).toBe('AAPL');
  });

  it('앞뒤 공백을 제거한다', () => {
    const symbol = createTickerSymbol('  BTC-USD  ');
    expect(symbol).toBe('BTC-USD');
  });

  it('이미 대문자인 심볼을 그대로 반환한다', () => {
    const symbol = createTickerSymbol('005930.KS');
    expect(symbol).toBe('005930.KS');
  });
});

describe('createCurrencyCode', () => {
  it('유효한 ISO 4217 코드를 생성한다', () => {
    const code = createCurrencyCode('usd');
    expect(code).toBe('USD');
  });

  it('앞뒤 공백을 제거한다', () => {
    const code = createCurrencyCode('  krw  ');
    expect(code).toBe('KRW');
  });

  it('4글자 코드에 에러를 던진다', () => {
    expect(() => createCurrencyCode('ABCD')).toThrow('Invalid currency code');
  });

  it('2글자 코드에 에러를 던진다', () => {
    expect(() => createCurrencyCode('US')).toThrow('Invalid currency code');
  });

  it('숫자 포함 코드에 에러를 던진다', () => {
    expect(() => createCurrencyCode('U1D')).toThrow('Invalid currency code');
  });
});
```

### T6-4. `packages/types/test/type-safety.test.ts` (신규)

Brand 타입의 컴파일 타임 안전성 검증 (`expectTypeOf` 활용).

```typescript
import { describe, it, expectTypeOf } from 'vitest';
import type {
  Timestamp,
  SessionKey,
  AgentId,
  ChannelId,
  Brand,
  Result,
  FinClawError,
  ErrorReason,
} from '@finclaw/types';
import { createTimestamp, createSessionKey, createAgentId, createChannelId } from '@finclaw/types';

describe('Brand 타입 안전성', () => {
  it('팩토리 함수가 올바른 Brand 타입을 반환한다', () => {
    expectTypeOf(createTimestamp(0)).toMatchTypeOf<Timestamp>();
    expectTypeOf(createSessionKey('')).toMatchTypeOf<SessionKey>();
    expectTypeOf(createAgentId('')).toMatchTypeOf<AgentId>();
    expectTypeOf(createChannelId('')).toMatchTypeOf<ChannelId>();
  });

  it('plain number는 Timestamp에 할당 불가하다', () => {
    // @ts-expect-error -- plain number는 Brand 타입에 할당 불가
    const _ts: Timestamp = 42;
  });

  it('plain string은 SessionKey에 할당 불가하다', () => {
    // @ts-expect-error -- plain string은 Brand 타입에 할당 불가
    const _sk: SessionKey = 'key';
  });

  it('서로 다른 Brand 타입은 호환되지 않는다', () => {
    expectTypeOf<SessionKey>().not.toMatchTypeOf<AgentId>();
    expectTypeOf<AgentId>().not.toMatchTypeOf<ChannelId>();
    expectTypeOf<ChannelId>().not.toMatchTypeOf<SessionKey>();
  });
});

describe('Result 타입', () => {
  it('ok: true일 때 value를 갖는다', () => {
    const success: Result<number> = { ok: true, value: 42 };
    expectTypeOf(success).toMatchTypeOf<Result<number>>();
  });

  it('ok: false일 때 error를 갖는다', () => {
    const failure: Result<number> = { ok: false, error: new Error('fail') };
    expectTypeOf(failure).toMatchTypeOf<Result<number>>();
  });

  it('FinClawError를 에러 타입으로 사용할 수 있다', () => {
    expectTypeOf<Result<string, FinClawError>>().not.toBeAny();
  });
});

describe('ErrorReason', () => {
  it('정의된 7가지 값 중 하나이다', () => {
    expectTypeOf<'CONFIG_INVALID'>().toMatchTypeOf<ErrorReason>();
    expectTypeOf<'CHANNEL_OFFLINE'>().toMatchTypeOf<ErrorReason>();
    expectTypeOf<'AGENT_TIMEOUT'>().toMatchTypeOf<ErrorReason>();
    expectTypeOf<'STORAGE_FAILURE'>().toMatchTypeOf<ErrorReason>();
    expectTypeOf<'RATE_LIMITED'>().toMatchTypeOf<ErrorReason>();
    expectTypeOf<'AUTH_FAILURE'>().toMatchTypeOf<ErrorReason>();
    expectTypeOf<'INTERNAL'>().toMatchTypeOf<ErrorReason>();
  });

  it('정의되지 않은 값은 할당 불가하다', () => {
    expectTypeOf<'UNKNOWN'>().not.toMatchTypeOf<ErrorReason>();
  });
});
```

### 검증 (T6 전체)

- `pnpm test` — 4개 신규 테스트 파일 + 기존 `sample.test.ts` 모두 통과
- 기존 `sample.test.ts`는 Phase 0 scaffold로 변경 없이 유지

---

## T7. 전체 검증

### 왜

모든 변경(T1-T6)을 적용한 후 프로젝트 전체의 정합성을 확인한다.

### 검증 명령어 (순서대로 실행)

```bash
# 1. 타입 체크 (tsgo — 빠른 검증)
pnpm typecheck

# 2. 빌드 (tsc — .d.ts 생성 + 크로스 검증)
pnpm build

# 3. 테스트
pnpm test

# 4. 린트
pnpm lint
```

### 성공 기준

| 명령어           | 기대 결과                                      |
| ---------------- | ---------------------------------------------- |
| `pnpm typecheck` | 에러 0                                         |
| `pnpm build`     | `packages/types/dist/` 에 `.d.ts` + `.js` 생성 |
| `pnpm test`      | 5개 테스트 파일 전체 통과 (sample + 4개 신규)  |
| `pnpm lint`      | 에러/경고 0                                    |

추가 확인:

- `grep -r "AsyncDisposable" packages/types/src/` — 결과 0건
- `grep -r "TODO = 'stub'" packages/types/src/` — 결과 0건
- `ls packages/types/dist/index.d.ts` — 파일 존재

---

## 작업 순서 및 의존성

```
T1 (CleanupFn 리네이밍)
 └──→ T4 (channel.ts CleanupFn 반영)  ← T1에 의존

T2 (ErrorReason + FinClawError 추가)  ← 독립

T3 (ConfigIoDeps 추가)                ← 독립

T5 (barrel export)                    ← T1, T2, T3 완료 후 (export 대상이 확정되어야 함)
 └──→ T6 (테스트)                     ← T5에 의존 (@finclaw/types import 필요)
       └──→ T7 (전체 검증)            ← T6에 의존

권장 실행 순서: T1 → T4 → T2 → T3 → T5 → T6 → T7
```

---

## 변경 요약

| 파일                       | 변경 유형                | LOC 변화         |
| -------------------------- | ------------------------ | ---------------- |
| `src/common.ts`            | 수정 (리네이밍 + 추가)   | 54 → ~74 (+20)   |
| `src/config.ts`            | 수정 (추가)              | 163 → ~176 (+13) |
| `src/channel.ts`           | 수정 (import + 시그니처) | 변동 없음 (치환) |
| `src/index.ts`             | 전체 교체                | 2 → ~24 (+22)    |
| `test/config.test.ts`      | 신규                     | ~60              |
| `test/message.test.ts`     | 신규                     | ~70              |
| `test/finance.test.ts`     | 신규                     | ~45              |
| `test/type-safety.test.ts` | 신규                     | ~75              |
| **합계**                   |                          | **+~305**        |
