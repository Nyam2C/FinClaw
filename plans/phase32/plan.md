# Phase 32 — Backend-as-CLI (Claude Max 구독 활용 → API 비용 0원)

## Context

`_workspace/openclaw-similarity/SUMMARY-v2.md` + `openclaw-uniqueness.md` 의 deep-dive 결과: OpenClaw 의 시그니처 패턴이자 ★★★★★ 가치인 **Backend-as-CLI** 를 FinClaw 에 도입한다.

OpenClaw `src/agents/cli-runner.ts:35-359` + `cli-backends.ts:36-95` 의 핵심 메커니즘:

1. `claude` CLI 를 `child_process.spawn` 으로 실행
2. `clearEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_OLD']` — API 키 환경변수 제거
3. 그 결과 `claude` CLI 가 자체 OAuth 인증(= 사용자 Claude Code 구독) 으로 동작
4. `--session-id` / `--resume` 으로 multi-turn 대화 유지
5. `--output-format json` 또는 `jsonl` 로 출력 파싱
6. watchdog ratio 로 noOutputTimeout 자동 산출 (전체 timeout 의 70% 등)
7. process supervisor 로 PID/scope 추적 + cleanup

사용자 = **Claude Max 구독자** (이전 결정) → API 결제 0원으로 전환 가능. Max 의 5h-200~900 메시지 한도가 1인 비서 가동에 충분.

본 Phase 의 단일 목표: **dual-path provider** 를 도입하여 사용자가 config 한 줄로 `provider: "anthropic-sdk"` ↔ `"claude-cli"` 전환할 수 있게 한다. 기본값 유지 시 회귀 0.

### 사용자 컨텍스트 (Phase 32 진입 전 확정)

- **구독**: Claude Max — 본 Phase 의 직접 동기.
- **LLM provider**: Claude (Anthropic) 단일 — Backend-as-CLI 도 Anthropic backend, multi-vendor 비대상.
- **채널**: Discord 단일 — streaming 트레이드오프 (CLI 는 일괄 출력) 가 큰 이슈 아님 (Discord 는 typing indicator + 최종 응답 모델).
- **사용자 1인** + 모바일 비대상.
- **원칙 유지**: 감사 가능성·환각 방지·읽기 전용.

### 사용자 결정 사항 (Phase 32 시작 전)

본 Phase 진입 전 다음 6 가지 정책 결정이 필요. 미결정 시 각 트랙 시작 직전에 확정:

1. **Default provider** — `anthropic-sdk` (현재) vs `claude-cli` (비용 0). 본 plan 은 **opt-in** 으로 채택 — config `provider: "claude-cli"` 명시 시에만 활성. 기본값 SDK 유지.
2. **Streaming 정책** — CLI 는 일괄 출력 → Discord typing indicator 만 살리고 final answer 모델 유지. **chat-view (web)** 의 token-by-token streaming 은 SDK 모드에서만 동작. CLI 모드 시 web UI 가 spinner 표시.
3. **Tool 호출 정책** — `--dangerously-skip-permissions` 로 CLI 자체 도구 자동 승인. 단 FinClaw 의 9-stage policy 는 **CLI 외부에서** 적용 — 사용자 발화 → policy 통과 → CLI 호출 → CLI 가 자체 도구 호출 X (시스템 프롬프트로 "Tools are disabled" 명시, OpenClaw 패턴 그대로). 도구 실행은 FinClaw 측 server runner 가 별도 처리.
4. **Session 영속** — `--session-id` + `--resume` 사용. CLI 가 발급한 session_id 를 `agent_runs.cli_session_id` 컬럼에 저장. SQLite 마이그레이션 v10 → v11.
5. **Watchdog ratio** — fresh 0.6 (전체 60s → 36s noOutputTimeout), resume 0.4 (40s → 16s). OpenClaw 기본값 그대로 채택. 사용자가 config 로 override 가능.
6. **인증 만료 처리** — `claude login` 토큰 만료 시 FinClaw 가 감지하고 사용자에게 Discord 로 알림 + SDK 모드로 자동 fallback. failover 카운터에 누적.

읽기 전용 원칙은 **유지** — Backend 전환은 인증/spawn 모델 변경일 뿐, 데이터 변경 능력 추가 없음.

### 사실 검증 (HIGH 신뢰도, deep-dive + 직접 코드 확인)

| 항목                             | OpenClaw 원본 위치                 | FinClaw 적용 위치                                            | 검증 방식        |
| -------------------------------- | ---------------------------------- | ------------------------------------------------------------ | ---------------- |
| `runCliAgent` core               | `src/agents/cli-runner.ts:35-359`  | `packages/agent/src/providers/claude-cli/runner.ts` (신규)   | 직접 인용        |
| `DEFAULT_CLAUDE_BACKEND` config  | `src/agents/cli-backends.ts:36-95` | `packages/agent/src/providers/claude-cli/backends.ts` (신규) | 직접 인용        |
| `clearEnv` 메커니즘              | `cli-runner.ts:225-232`            | `claude-cli/runner.ts:env` 빌드 부                           | 직접 인용        |
| Watchdog ratio                   | `cli-runner/reliability.ts:1-80`   | `claude-cli/reliability.ts` (신규)                           | 직접 인용        |
| `enqueueCliRun` queue            | `cli-runner/helpers.ts:24-40`      | `claude-cli/queue.ts` (신규)                                 | 직접 인용        |
| `parseCliJson` / `parseCliJsonl` | `cli-runner/helpers.ts` 부분       | `claude-cli/parsers.ts` (신규)                               | 직접 인용        |
| Process supervisor               | `src/process/supervisor/index.ts`  | FinClaw `packages/server/src/process/` 기존 활용 (확장)      | 기존 인프라 활용 |

---

## 밀스톤 A — CLI Backend Config (Claude backend 정의)

### 목표

OpenClaw 의 `DEFAULT_CLAUDE_BACKEND` 를 FinClaw 의 config 형식으로 이식. 사용자가 `claude` CLI 를 어떻게 호출할지 결정하는 단일 진실의 출처(SoT).

### 작업

**파일:**

- `packages/agent/src/providers/claude-cli/backends.ts` (신규, ~150 LOC)
- `packages/agent/src/providers/claude-cli/types.ts` (신규, ~60 LOC — `CliBackendConfig` 타입)
- `packages/agent/test/providers/claude-cli/backends.test.ts` (신규, ~50 LOC)

#### A1. 타입 정의

OpenClaw 원본 (`src/config/types.ts` 의 `CliBackendConfig`) 발췌 → FinClaw 형식:

```ts
// packages/agent/src/providers/claude-cli/types.ts

export type CliOutputMode = 'json' | 'jsonl' | 'text';

export interface CliWatchdogProfile {
  noOutputTimeoutMs?: number; // 명시 값 (있으면 ratio 무시)
  noOutputTimeoutRatio: number; // 0.05~0.95
  minMs: number;
  maxMs: number;
}

export interface CliReliabilityConfig {
  watchdog?: {
    fresh?: Partial<CliWatchdogProfile>;
    resume?: Partial<CliWatchdogProfile>;
  };
}

export interface CliBackendConfig {
  command: string; // "claude"
  args: string[]; // 첫 호출 시
  resumeArgs?: string[]; // --resume 시
  output: CliOutputMode;
  resumeOutput?: CliOutputMode;
  input: 'arg' | 'stdin';
  modelArg: string; // "--model"
  modelAliases?: Record<string, string>;
  sessionArg?: string; // "--session-id"
  sessionMode?: 'always' | 'existing';
  sessionIdFields?: string[]; // ["session_id", "sessionId", ...]
  systemPromptArg?: string; // "--append-system-prompt"
  systemPromptMode?: 'append' | 'replace';
  systemPromptWhen?: 'first' | 'always';
  imageArg?: string;
  imageMode?: 'repeat' | 'csv';
  clearEnv?: string[]; // ["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY_OLD"]
  env?: Record<string, string>;
  reliability?: CliReliabilityConfig;
  serialize?: boolean; // 같은 backend 동시 실행 직렬화
}
```

#### A2. Default Claude backend

OpenClaw 원본 (`src/agents/cli-backends.ts:36-95`) 거의 그대로:

```ts
// packages/agent/src/providers/claude-cli/backends.ts

import type { CliBackendConfig } from './types.js';

const CLAUDE_MODEL_ALIASES: Record<string, string> = {
  opus: 'opus',
  'opus-4.6': 'opus',
  'opus-4.5': 'opus',
  'opus-4': 'opus',
  'claude-opus-4-6': 'opus',
  'claude-opus-4-5': 'opus',
  'claude-opus-4': 'opus',
  sonnet: 'sonnet',
  'sonnet-4.6': 'sonnet',
  'sonnet-4.5': 'sonnet',
  'claude-sonnet-4-6': 'sonnet',
  'claude-sonnet-4-5': 'sonnet',
  haiku: 'haiku',
  'haiku-3.5': 'haiku',
  'claude-haiku-3-5': 'haiku',
};

// OpenClaw 기본값 (cli-watchdog-defaults.ts:1-30 참조)
const FRESH_WATCHDOG = { noOutputTimeoutRatio: 0.6, minMs: 30_000, maxMs: 240_000 };
const RESUME_WATCHDOG = { noOutputTimeoutRatio: 0.4, minMs: 15_000, maxMs: 90_000 };

export const DEFAULT_CLAUDE_BACKEND: CliBackendConfig = {
  command: 'claude',
  args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions'],
  resumeArgs: [
    '-p',
    '--output-format',
    'json',
    '--dangerously-skip-permissions',
    '--resume',
    '{sessionId}',
  ],
  output: 'json',
  input: 'arg',
  modelArg: '--model',
  modelAliases: CLAUDE_MODEL_ALIASES,
  sessionArg: '--session-id',
  sessionMode: 'always',
  sessionIdFields: ['session_id', 'sessionId', 'conversation_id', 'conversationId'],
  systemPromptArg: '--append-system-prompt',
  systemPromptMode: 'append',
  systemPromptWhen: 'first',
  // ★ 핵심: API 키를 비워서 claude CLI 가 OAuth/구독 인증을 사용하게 강제
  clearEnv: ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_OLD'],
  reliability: {
    watchdog: { fresh: FRESH_WATCHDOG, resume: RESUME_WATCHDOG },
  },
  serialize: true,
};

export function resolveClaudeBackend(override?: Partial<CliBackendConfig>): CliBackendConfig {
  if (!override) return DEFAULT_CLAUDE_BACKEND;
  return {
    ...DEFAULT_CLAUDE_BACKEND,
    ...override,
    args: override.args ?? DEFAULT_CLAUDE_BACKEND.args,
    resumeArgs: override.resumeArgs ?? DEFAULT_CLAUDE_BACKEND.resumeArgs,
    clearEnv: Array.from(
      new Set([...(DEFAULT_CLAUDE_BACKEND.clearEnv ?? []), ...(override.clearEnv ?? [])]),
    ),
    reliability: override.reliability ?? DEFAULT_CLAUDE_BACKEND.reliability,
  };
}

export function normalizeClaudeModel(modelId: string, backend: CliBackendConfig): string {
  const lower = modelId.trim().toLowerCase();
  return backend.modelAliases?.[lower] ?? modelId;
}
```

#### A3. 테스트

```ts
import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CLAUDE_BACKEND,
  resolveClaudeBackend,
  normalizeClaudeModel,
} from '../../../src/providers/claude-cli/backends.js';

describe('DEFAULT_CLAUDE_BACKEND', () => {
  it('clears ANTHROPIC_API_KEY env', () => {
    expect(DEFAULT_CLAUDE_BACKEND.clearEnv).toContain('ANTHROPIC_API_KEY');
    expect(DEFAULT_CLAUDE_BACKEND.clearEnv).toContain('ANTHROPIC_API_KEY_OLD');
  });

  it('uses --dangerously-skip-permissions for tool auto-approve', () => {
    expect(DEFAULT_CLAUDE_BACKEND.args).toContain('--dangerously-skip-permissions');
  });

  it('outputs json by default', () => {
    expect(DEFAULT_CLAUDE_BACKEND.output).toBe('json');
  });

  it('uses --session-id for multi-turn', () => {
    expect(DEFAULT_CLAUDE_BACKEND.sessionArg).toBe('--session-id');
    expect(DEFAULT_CLAUDE_BACKEND.sessionMode).toBe('always');
  });
});

describe('resolveClaudeBackend', () => {
  it('returns default when no override', () => {
    expect(resolveClaudeBackend()).toBe(DEFAULT_CLAUDE_BACKEND);
  });

  it('merges clearEnv (union)', () => {
    const merged = resolveClaudeBackend({ clearEnv: ['ANTHROPIC_BASE_URL'] });
    expect(merged.clearEnv).toEqual(
      expect.arrayContaining(['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_OLD', 'ANTHROPIC_BASE_URL']),
    );
  });
});

describe('normalizeClaudeModel', () => {
  it('aliases sonnet-4.5 to sonnet', () => {
    expect(normalizeClaudeModel('sonnet-4.5', DEFAULT_CLAUDE_BACKEND)).toBe('sonnet');
  });
  it('aliases case-insensitive', () => {
    expect(normalizeClaudeModel('CLAUDE-OPUS-4-6', DEFAULT_CLAUDE_BACKEND)).toBe('opus');
  });
  it('passes through unknown', () => {
    expect(normalizeClaudeModel('custom-x', DEFAULT_CLAUDE_BACKEND)).toBe('custom-x');
  });
});
```

### 완료 조건

- 단위 테스트 7개 통과
- `clearEnv` 가 `ANTHROPIC_API_KEY` 포함 검증
- 회귀 0

### 추정

**4 시간**

---

## 밀스톤 B — Watchdog Ratio (전체 timeout → noOutput timeout 자동 산출)

### 목표

OpenClaw `cli-runner/reliability.ts:1-80` 의 `resolveCliNoOutputTimeoutMs` 그대로 이식. fresh/resume 으로 다른 ratio 프로파일 (fresh 더 길게, resume 짧게) + cap = `timeoutMs - 1000`.

### 작업

**파일:**

- `packages/agent/src/providers/claude-cli/reliability.ts` (신규, ~80 LOC)
- `packages/agent/test/providers/claude-cli/reliability.test.ts` (신규, ~60 LOC)

#### B1. `reliability.ts` — OpenClaw 그대로

OpenClaw 원본 (`src/agents/cli-runner/reliability.ts:1-80`) 거의 그대로 복붙. `path.basename` 의존하는 `buildCliSupervisorScopeKey` 는 다음 밀스톤(C) 으로 분리:

```ts
// packages/agent/src/providers/claude-cli/reliability.ts

import type { CliBackendConfig, CliWatchdogProfile } from './types.js';

export const CLI_WATCHDOG_MIN_TIMEOUT_MS = 5_000;

const FRESH_WATCHDOG_DEFAULTS: CliWatchdogProfile = {
  noOutputTimeoutRatio: 0.6,
  minMs: 30_000,
  maxMs: 240_000,
};
const RESUME_WATCHDOG_DEFAULTS: CliWatchdogProfile = {
  noOutputTimeoutRatio: 0.4,
  minMs: 15_000,
  maxMs: 90_000,
};

function pickWatchdogProfile(backend: CliBackendConfig, useResume: boolean): CliWatchdogProfile {
  const defaults = useResume ? RESUME_WATCHDOG_DEFAULTS : FRESH_WATCHDOG_DEFAULTS;
  const configured = useResume
    ? backend.reliability?.watchdog?.resume
    : backend.reliability?.watchdog?.fresh;

  const ratio = (() => {
    const v = configured?.noOutputTimeoutRatio;
    if (typeof v !== 'number' || !Number.isFinite(v)) return defaults.noOutputTimeoutRatio;
    return Math.max(0.05, Math.min(0.95, v));
  })();

  const minMs = (() => {
    const v = configured?.minMs;
    if (typeof v !== 'number' || !Number.isFinite(v)) return defaults.minMs;
    return Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(v));
  })();

  const maxMs = (() => {
    const v = configured?.maxMs;
    if (typeof v !== 'number' || !Number.isFinite(v)) return defaults.maxMs;
    return Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(v));
  })();

  return {
    noOutputTimeoutMs:
      typeof configured?.noOutputTimeoutMs === 'number' &&
      Number.isFinite(configured.noOutputTimeoutMs)
        ? Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, Math.floor(configured.noOutputTimeoutMs))
        : undefined,
    noOutputTimeoutRatio: ratio,
    minMs: Math.min(minMs, maxMs),
    maxMs: Math.max(minMs, maxMs),
  };
}

export function resolveCliNoOutputTimeoutMs(params: {
  backend: CliBackendConfig;
  timeoutMs: number;
  useResume: boolean;
}): number {
  const profile = pickWatchdogProfile(params.backend, params.useResume);
  // overall timeout 보다 1초 일찍 watchdog 발동 → 정확한 reason 분류 시간 확보
  const cap = Math.max(CLI_WATCHDOG_MIN_TIMEOUT_MS, params.timeoutMs - 1_000);
  if (profile.noOutputTimeoutMs !== undefined) {
    return Math.min(profile.noOutputTimeoutMs, cap);
  }
  const computed = Math.floor(params.timeoutMs * profile.noOutputTimeoutRatio);
  const bounded = Math.min(profile.maxMs, Math.max(profile.minMs, computed));
  return Math.min(bounded, cap);
}
```

#### B2. 테스트

```ts
import { describe, it, expect } from 'vitest';
import { resolveCliNoOutputTimeoutMs } from '../../../src/providers/claude-cli/reliability.js';
import { DEFAULT_CLAUDE_BACKEND } from '../../../src/providers/claude-cli/backends.js';

describe('resolveCliNoOutputTimeoutMs', () => {
  it('uses fresh ratio (0.6) by default', () => {
    const result = resolveCliNoOutputTimeoutMs({
      backend: DEFAULT_CLAUDE_BACKEND,
      timeoutMs: 60_000,
      useResume: false,
    });
    // 60_000 * 0.6 = 36_000, bounded by min(30_000) ~ max(240_000), cap 59_000
    expect(result).toBe(36_000);
  });

  it('uses resume ratio (0.4) on resume', () => {
    const result = resolveCliNoOutputTimeoutMs({
      backend: DEFAULT_CLAUDE_BACKEND,
      timeoutMs: 60_000,
      useResume: true,
    });
    // 60_000 * 0.4 = 24_000, bounded by min(15_000) ~ max(90_000)
    expect(result).toBe(24_000);
  });

  it('caps at timeoutMs - 1000', () => {
    const result = resolveCliNoOutputTimeoutMs({
      backend: DEFAULT_CLAUDE_BACKEND,
      timeoutMs: 10_000,
      useResume: false,
    });
    // 10_000 * 0.6 = 6_000, but cap = 9_000 → 6_000
    // min check: max(5_000, 6_000) = 6_000
    expect(result).toBe(6_000);
  });

  it('respects explicit noOutputTimeoutMs', () => {
    const backend = {
      ...DEFAULT_CLAUDE_BACKEND,
      reliability: {
        watchdog: {
          fresh: {
            noOutputTimeoutRatio: 0.6,
            minMs: 30_000,
            maxMs: 240_000,
            noOutputTimeoutMs: 45_000,
          },
        },
      },
    };
    const result = resolveCliNoOutputTimeoutMs({ backend, timeoutMs: 60_000, useResume: false });
    expect(result).toBe(45_000);
  });

  it('clamps ratio outside [0.05, 0.95]', () => {
    const backend = {
      ...DEFAULT_CLAUDE_BACKEND,
      reliability: {
        watchdog: { fresh: { noOutputTimeoutRatio: 1.5, minMs: 30_000, maxMs: 240_000 } },
      },
    };
    const result = resolveCliNoOutputTimeoutMs({ backend, timeoutMs: 60_000, useResume: false });
    // ratio clamped to 0.95 → 60_000 * 0.95 = 57_000, cap = 59_000
    expect(result).toBe(57_000);
  });
});
```

### 완료 조건

- 단위 테스트 5개 통과

### 추정

**2 시간**

---

## 밀스톤 C — Process Spawn + Queue + Cleanup

### 목표

OpenClaw 의 `process.supervisor.spawn` + `enqueueCliRun` 큐 + cleanup signal handling 을 FinClaw 에 이식. FinClaw 의 기존 `packages/server/src/process/` 를 확장하여 `spawn` 메서드 추가.

### 작업

**파일:**

- `packages/agent/src/providers/claude-cli/queue.ts` (신규, ~60 LOC — `enqueueCliRun`)
- `packages/agent/src/providers/claude-cli/spawn.ts` (신규, ~120 LOC — child_process spawn + watchdog timer)
- `packages/agent/test/providers/claude-cli/queue.test.ts` (신규, ~60 LOC)
- `packages/agent/test/providers/claude-cli/spawn.test.ts` (신규, ~80 LOC — mock 자식 프로세스)

#### C1. `queue.ts` — OpenClaw 원본 그대로

OpenClaw `src/agents/cli-runner/helpers.ts:24-40` (그대로 이식):

```ts
// packages/agent/src/providers/claude-cli/queue.ts

const CLI_RUN_QUEUE = new Map<string, Promise<unknown>>();

/**
 * 같은 key (= backend + cliSessionId 조합) 의 동시 실행 직렬화.
 * 큰 효용: --session-id 가 같은 세션의 동시 실행 시 충돌 방지.
 */
export function enqueueCliRun<T>(key: string, task: () => Promise<T>): Promise<T> {
  const prior = CLI_RUN_QUEUE.get(key) ?? Promise.resolve();
  const chained = prior.catch(() => undefined).then(task);
  // queue 연속성 유지 — 실패해도 unhandled rejection 방출 안 함
  const tracked = chained
    .catch(() => undefined)
    .finally(() => {
      if (CLI_RUN_QUEUE.get(key) === tracked) {
        CLI_RUN_QUEUE.delete(key);
      }
    });
  CLI_RUN_QUEUE.set(key, tracked);
  return chained;
}

export function buildCliQueueKey(params: { backendId: string; cliSessionId?: string }): string {
  return params.cliSessionId ? `${params.backendId}:${params.cliSessionId}` : params.backendId;
}
```

#### C2. `spawn.ts` — child_process + watchdog

OpenClaw `src/process/supervisor/index.ts:spawn` 의 핵심 로직을 단순화하여 이식. FinClaw 의 기존 process supervisor 가 있다면 활용, 없으면 standalone:

```ts
// packages/agent/src/providers/claude-cli/spawn.ts

import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process';

export interface SpawnRequest {
  argv: [string, ...string[]]; // [command, ...args]
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string; // stdin
  timeoutMs: number; // overall
  noOutputTimeoutMs: number; // watchdog
  signal?: AbortSignal;
}

export type SpawnReason = 'exit' | 'overall-timeout' | 'no-output-timeout' | 'aborted';

export interface SpawnResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  reason: SpawnReason;
  pid?: number;
  noOutputTimedOut: boolean;
  durationMs: number;
}

export async function spawnWithWatchdog(req: SpawnRequest): Promise<SpawnResult> {
  const [command, ...args] = req.argv;
  const startedAt = Date.now();

  return new Promise<SpawnResult>((resolve) => {
    let child: ChildProcess;
    let stdout = '';
    let stderr = '';
    let lastOutputAt = Date.now();
    let resolved = false;
    let reason: SpawnReason = 'exit';
    let noOutputTimedOut = false;

    const finalize = (final: SpawnReason, exitCode: number | null = null) => {
      if (resolved) return;
      resolved = true;
      reason = final;
      try {
        child?.kill('SIGTERM');
      } catch {}
      // 2초 후에도 살아있으면 SIGKILL
      setTimeout(() => {
        try {
          child?.kill('SIGKILL');
        } catch {}
      }, 2_000);
      resolve({
        exitCode,
        stdout,
        stderr,
        reason: final,
        pid: child?.pid,
        noOutputTimedOut,
        durationMs: Date.now() - startedAt,
      });
    };

    try {
      child = nodeSpawn(command, args, {
        cwd: req.cwd,
        env: req.env,
        stdio: req.input ? ['pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({
        exitCode: null,
        stdout: '',
        stderr: err instanceof Error ? err.message : String(err),
        reason: 'exit',
        noOutputTimedOut: false,
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    if (req.input && child.stdin) {
      child.stdin.write(req.input);
      child.stdin.end();
    }

    child.stdout?.on('data', (d) => {
      stdout += d.toString();
      lastOutputAt = Date.now();
    });
    child.stderr?.on('data', (d) => {
      stderr += d.toString();
      lastOutputAt = Date.now();
    });

    child.on('exit', (code) => finalize('exit', code));
    child.on('error', (err) => {
      stderr += `\n[spawn error] ${err.message}`;
      finalize('exit', null);
    });

    // watchdog: noOutput timeout (slide window)
    const watchdog = setInterval(
      () => {
        const idle = Date.now() - lastOutputAt;
        if (idle >= req.noOutputTimeoutMs) {
          noOutputTimedOut = true;
          clearInterval(watchdog);
          finalize('no-output-timeout');
        }
      },
      Math.min(req.noOutputTimeoutMs / 4, 2_000),
    );

    // overall timeout
    const overallTimer = setTimeout(() => {
      clearInterval(watchdog);
      finalize('overall-timeout');
    }, req.timeoutMs);

    // abort signal
    req.signal?.addEventListener(
      'abort',
      () => {
        clearInterval(watchdog);
        clearTimeout(overallTimer);
        finalize('aborted');
      },
      { once: true },
    );

    // 정리: exit 시 timer 들 클리어
    child.once('exit', () => {
      clearInterval(watchdog);
      clearTimeout(overallTimer);
    });
  });
}
```

#### C3. 테스트

```ts
import { describe, it, expect } from 'vitest';
import { enqueueCliRun, buildCliQueueKey } from '../../../src/providers/claude-cli/queue.js';
import { spawnWithWatchdog } from '../../../src/providers/claude-cli/spawn.js';

describe('enqueueCliRun', () => {
  it('serializes same-key tasks', async () => {
    const log: string[] = [];
    const t1 = enqueueCliRun('k1', async () => {
      await new Promise((r) => setTimeout(r, 30));
      log.push('t1');
    });
    const t2 = enqueueCliRun('k1', async () => {
      log.push('t2');
    });
    await Promise.all([t1, t2]);
    expect(log).toEqual(['t1', 't2']);
  });

  it('does NOT serialize different-key tasks', async () => {
    const log: string[] = [];
    const t1 = enqueueCliRun('k1', async () => {
      await new Promise((r) => setTimeout(r, 30));
      log.push('t1');
    });
    const t2 = enqueueCliRun('k2', async () => {
      log.push('t2');
    });
    await Promise.all([t1, t2]);
    // t2 가 먼저 끝남 (병렬)
    expect(log).toEqual(['t2', 't1']);
  });
});

describe('spawnWithWatchdog', () => {
  it('captures stdout for short-lived process', async () => {
    const result = await spawnWithWatchdog({
      argv: ['node', '-e', 'process.stdout.write("hello")'],
      timeoutMs: 5_000,
      noOutputTimeoutMs: 3_000,
    });
    expect(result.reason).toBe('exit');
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('hello');
  });

  it('kills on overall timeout', async () => {
    const result = await spawnWithWatchdog({
      argv: ['node', '-e', 'setInterval(() => {}, 1000)'],
      timeoutMs: 500,
      noOutputTimeoutMs: 10_000,
    });
    expect(result.reason).toBe('overall-timeout');
  });

  it('kills on no-output timeout (idle process)', async () => {
    const result = await spawnWithWatchdog({
      argv: ['node', '-e', 'process.stdout.write("a"); setInterval(() => {}, 5000)'],
      timeoutMs: 10_000,
      noOutputTimeoutMs: 500,
    });
    expect(result.reason).toBe('no-output-timeout');
    expect(result.noOutputTimedOut).toBe(true);
  });
});
```

### 완료 조건

- 단위 테스트 5개 통과
- watchdog timeout 시 SIGTERM → 2s 후 SIGKILL 검증
- 회귀 0

### 추정

**1 일** (queue 2h + spawn 4h + 테스트 2h)

---

## 밀스톤 D — JSON / JSONL Output Parsers

### 목표

`claude` CLI 의 `--output-format json` (단일 JSON object) 과 `codex` 류의 `--json` (JSONL = 줄당 JSON) 두 모드 출력을 표준화된 `CliOutput` 으로 파싱.

### 작업

**파일:**

- `packages/agent/src/providers/claude-cli/parsers.ts` (신규, ~100 LOC)
- `packages/agent/test/providers/claude-cli/parsers.test.ts` (신규, ~80 LOC)

#### D1. `parsers.ts`

```ts
// packages/agent/src/providers/claude-cli/parsers.ts

import type { CliBackendConfig } from './types.js';

export interface CliUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

export interface CliOutput {
  text: string;
  sessionId?: string;
  usage?: CliUsage;
}

/** 단일 JSON object 출력 (claude CLI 의 --output-format json) */
export function parseCliJson(stdout: string, backend: CliBackendConfig): CliOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') return undefined;

  const obj = parsed as Record<string, unknown>;
  const text = pickText(obj);
  const sessionId = pickSessionId(obj, backend);
  const usage = pickUsage(obj);
  return { text, sessionId, usage };
}

/** JSONL (codex) — 마지막 final 메시지 또는 누적 텍스트 */
export function parseCliJsonl(stdout: string, backend: CliBackendConfig): CliOutput | undefined {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean);
  if (!lines.length) return undefined;

  let text = '';
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;

  for (const line of lines) {
    let obj: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') obj = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (!obj) continue;

    const t = pickText(obj);
    if (t) text = text ? `${text}\n${t}` : t;

    const sid = pickSessionId(obj, backend);
    if (sid && !sessionId) sessionId = sid;

    const u = pickUsage(obj);
    if (u) usage = mergeUsage(usage, u);
  }

  return text ? { text, sessionId, usage } : undefined;
}

function pickText(obj: Record<string, unknown>): string {
  // claude CLI: { type: 'result', result: '...', is_error: false }
  if (typeof obj.result === 'string') return obj.result;
  // 일반: { content: [{ type: 'text', text: '...' }] } 또는 { text: '...' }
  if (typeof obj.text === 'string') return obj.text;
  if (Array.isArray(obj.content)) {
    return obj.content
      .filter(
        (c): c is { type: string; text: string } =>
          c &&
          typeof c === 'object' &&
          (c as any).type === 'text' &&
          typeof (c as any).text === 'string',
      )
      .map((c) => c.text)
      .join('\n');
  }
  if (typeof obj.message === 'string') return obj.message;
  return '';
}

function pickSessionId(
  obj: Record<string, unknown>,
  backend: CliBackendConfig,
): string | undefined {
  for (const field of backend.sessionIdFields ?? []) {
    const v = obj[field];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}

function pickUsage(obj: Record<string, unknown>): CliUsage | undefined {
  const usage = obj.usage;
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const num = (k: string) =>
    typeof u[k] === 'number' && Number.isFinite(u[k]) ? (u[k] as number) : undefined;
  return {
    input: num('input_tokens') ?? num('input'),
    output: num('output_tokens') ?? num('output'),
    cacheRead: num('cache_read_input_tokens') ?? num('cacheRead'),
    cacheWrite: num('cache_creation_input_tokens') ?? num('cacheWrite'),
    total: num('total_tokens') ?? num('total'),
  };
}

function mergeUsage(a: CliUsage | undefined, b: CliUsage): CliUsage {
  if (!a) return b;
  return {
    input: (a.input ?? 0) + (b.input ?? 0),
    output: (a.output ?? 0) + (b.output ?? 0),
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
    total: (a.total ?? 0) + (b.total ?? 0),
  };
}
```

#### D2. 테스트

claude CLI 의 실제 출력 형식 fixture 사용:

```ts
import { describe, it, expect } from 'vitest';
import { parseCliJson, parseCliJsonl } from '../../../src/providers/claude-cli/parsers.js';
import { DEFAULT_CLAUDE_BACKEND } from '../../../src/providers/claude-cli/backends.js';

describe('parseCliJson (claude format)', () => {
  it('parses claude CLI result format', () => {
    const stdout = JSON.stringify({
      type: 'result',
      result: '안녕하세요',
      session_id: 'sess_abc123',
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
      is_error: false,
    });
    const r = parseCliJson(stdout, DEFAULT_CLAUDE_BACKEND);
    expect(r?.text).toBe('안녕하세요');
    expect(r?.sessionId).toBe('sess_abc123');
    expect(r?.usage?.input).toBe(10);
    expect(r?.usage?.output).toBe(5);
    expect(r?.usage?.cacheRead).toBe(100);
  });

  it('returns undefined for empty stdout', () => {
    expect(parseCliJson('', DEFAULT_CLAUDE_BACKEND)).toBeUndefined();
  });

  it('returns undefined for invalid JSON', () => {
    expect(parseCliJson('not json', DEFAULT_CLAUDE_BACKEND)).toBeUndefined();
  });
});

describe('parseCliJsonl', () => {
  it('accumulates text across lines + picks first sessionId', () => {
    const stdout = [
      JSON.stringify({ thread_id: 't1', text: 'hello' }),
      JSON.stringify({ text: 'world' }),
      JSON.stringify({ usage: { input_tokens: 5 } }),
    ].join('\n');
    const codexBackend = { ...DEFAULT_CLAUDE_BACKEND, sessionIdFields: ['thread_id'] };
    const r = parseCliJsonl(stdout, codexBackend);
    expect(r?.text).toBe('hello\nworld');
    expect(r?.sessionId).toBe('t1');
    expect(r?.usage?.input).toBe(5);
  });
});
```

### 완료 조건

- 단위 테스트 5개 통과
- 실제 claude CLI 출력 1개 fixture 검증

### 추정

**3 시간**

---

## 밀스톤 E — `runCliAgent` Core (조합 + FailoverError 변환)

### 목표

A/B/C/D 를 합쳐 `runCliAgent` 함수 작성. OpenClaw `cli-runner.ts:35-359` 의 핵심 흐름:

1. backend resolve + model 정규화
2. cliSessionId / useResume 결정
3. args 빌드 + env 빌드 (clearEnv)
4. queue 키 생성 → enqueue
5. spawn + watchdog
6. 결과 파싱 (json/jsonl)
7. 에러 분류 → FailoverError throw

### 작업

**파일:**

- `packages/agent/src/providers/claude-cli/runner.ts` (신규, ~250 LOC)
- `packages/agent/src/providers/claude-cli/errors.ts` (신규, ~40 LOC — `CliFailoverReason`)
- `packages/agent/test/providers/claude-cli/runner.test.ts` (신규, ~120 LOC — mock spawn)

#### E1. Errors

```ts
// packages/agent/src/providers/claude-cli/errors.ts

export type CliFailoverReason =
  | 'auth'
  | 'rate_limit'
  | 'timeout'
  | 'format'
  | 'model_not_found'
  | 'unknown';

export class CliFailoverError extends Error {
  readonly reason: CliFailoverReason;
  readonly provider: string;
  readonly model: string;
  readonly status?: number;

  constructor(
    message: string,
    opts: {
      reason: CliFailoverReason;
      provider: string;
      model: string;
      status?: number;
    },
  ) {
    super(message);
    this.name = 'CliFailoverError';
    this.reason = opts.reason;
    this.provider = opts.provider;
    this.model = opts.model;
    this.status = opts.status;
  }
}

const TIMEOUT_RE = /timeout|timed out|deadline exceeded|no output for/i;
const AUTH_RE = /(unauthor|forbid|invalid.+token|please log ?in|claude login)/i;
const RATE_LIMIT_RE = /(rate ?limit|too many req|quota)/i;

export function classifyCliError(message: string): CliFailoverReason {
  if (AUTH_RE.test(message)) return 'auth';
  if (RATE_LIMIT_RE.test(message)) return 'rate_limit';
  if (TIMEOUT_RE.test(message)) return 'timeout';
  return 'unknown';
}
```

#### E2. `runner.ts`

OpenClaw `cli-runner.ts:35-359` 단순화 이식 (워크스페이스/이미지/도구 disable 부분 포함):

```ts
// packages/agent/src/providers/claude-cli/runner.ts

import type { CliBackendConfig } from './types.js';
import { CliFailoverError, classifyCliError } from './errors.js';
import { resolveCliNoOutputTimeoutMs } from './reliability.js';
import { spawnWithWatchdog } from './spawn.js';
import { buildCliQueueKey, enqueueCliRun } from './queue.js';
import { parseCliJson, parseCliJsonl, type CliOutput } from './parsers.js';
import { DEFAULT_CLAUDE_BACKEND, normalizeClaudeModel } from './backends.js';

export interface RunCliAgentRequest {
  prompt: string;
  systemPrompt?: string;
  modelId?: string;
  cliSessionId?: string;
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  cwd?: string;
  backend?: CliBackendConfig;
}

export interface RunCliAgentResponse {
  text: string;
  sessionId?: string;
  usage?: CliOutput['usage'];
  durationMs: number;
}

export async function runCliAgent(req: RunCliAgentRequest): Promise<RunCliAgentResponse> {
  const backend = req.backend ?? DEFAULT_CLAUDE_BACKEND;
  const modelId = (req.modelId ?? 'sonnet').trim() || 'sonnet';
  const normalizedModel = normalizeClaudeModel(modelId, backend);
  const useResume = Boolean(req.cliSessionId);
  const provider = 'claude-cli';
  const startedAt = Date.now();

  // args 빌드
  const baseArgs = useResume && backend.resumeArgs ? [...backend.resumeArgs] : [...backend.args];
  const args = baseArgs.map((a) => a.replace('{sessionId}', req.cliSessionId ?? ''));
  if (backend.modelArg) args.push(backend.modelArg, normalizedModel);
  if (
    backend.systemPromptArg &&
    req.systemPrompt &&
    (backend.systemPromptWhen !== 'first' || !useResume)
  ) {
    args.push(backend.systemPromptArg, req.systemPrompt);
  }
  if (backend.input === 'arg') {
    args.push(req.prompt);
  }

  // env (clearEnv 적용)
  const env: NodeJS.ProcessEnv = { ...process.env, ...backend.env };
  for (const key of backend.clearEnv ?? []) {
    delete env[key];
  }

  // watchdog
  const timeoutMs = req.timeoutMs ?? 60_000;
  const noOutputTimeoutMs = resolveCliNoOutputTimeoutMs({ backend, timeoutMs, useResume });

  // queue
  const queueKey = buildCliQueueKey({
    backendId: 'claude',
    cliSessionId: useResume ? req.cliSessionId : undefined,
  });

  const result = await enqueueCliRun(queueKey, async () => {
    return spawnWithWatchdog({
      argv: [backend.command, ...args] as [string, ...string[]],
      cwd: req.cwd,
      env,
      input: backend.input === 'stdin' ? req.prompt : undefined,
      timeoutMs,
      noOutputTimeoutMs,
      signal: req.abortSignal,
    });
  });

  // 에러 분류
  if (result.exitCode !== 0 || result.reason !== 'exit') {
    const message = result.stderr.trim() || result.stdout.trim() || 'CLI failed.';
    if (result.reason === 'no-output-timeout' || result.noOutputTimedOut) {
      throw new CliFailoverError(
        `CLI produced no output for ${Math.round(noOutputTimeoutMs / 1000)}s.`,
        { reason: 'timeout', provider, model: modelId, status: 408 },
      );
    }
    if (result.reason === 'overall-timeout') {
      throw new CliFailoverError(
        `CLI exceeded overall timeout (${Math.round(timeoutMs / 1000)}s).`,
        { reason: 'timeout', provider, model: modelId, status: 408 },
      );
    }
    if (result.reason === 'aborted') {
      throw new CliFailoverError('CLI aborted.', { reason: 'unknown', provider, model: modelId });
    }
    const reason = classifyCliError(message);
    throw new CliFailoverError(message, { reason, provider, model: modelId });
  }

  // 출력 파싱
  const outputMode = useResume ? (backend.resumeOutput ?? backend.output) : backend.output;
  let parsed: CliOutput | undefined;
  if (outputMode === 'text') {
    parsed = { text: result.stdout.trim() };
  } else if (outputMode === 'jsonl') {
    parsed = parseCliJsonl(result.stdout, backend) ?? { text: result.stdout.trim() };
  } else {
    parsed = parseCliJson(result.stdout, backend) ?? { text: result.stdout.trim() };
  }

  return {
    text: parsed?.text ?? '',
    sessionId: parsed?.sessionId,
    usage: parsed?.usage,
    durationMs: Date.now() - startedAt,
  };
}
```

#### E3. 테스트 (mock spawn)

`spawnWithWatchdog` 를 mock 하여 결과 분기 검증:

```ts
import { describe, it, expect, vi } from 'vitest';
import * as spawnMod from '../../../src/providers/claude-cli/spawn.js';
import { runCliAgent } from '../../../src/providers/claude-cli/runner.js';
import { CliFailoverError } from '../../../src/providers/claude-cli/errors.js';

describe('runCliAgent', () => {
  it('returns text on successful claude json output', async () => {
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockResolvedValue({
      exitCode: 0,
      reason: 'exit',
      stdout: JSON.stringify({
        type: 'result',
        result: '안녕',
        session_id: 'sess1',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      stderr: '',
      noOutputTimedOut: false,
      durationMs: 100,
    });
    const r = await runCliAgent({ prompt: 'hi', timeoutMs: 60_000 });
    expect(r.text).toBe('안녕');
    expect(r.sessionId).toBe('sess1');
    expect(r.usage?.input).toBe(10);
  });

  it('throws CliFailoverError(timeout) on no-output-timeout', async () => {
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockResolvedValue({
      exitCode: null,
      reason: 'no-output-timeout',
      stdout: '',
      stderr: '',
      noOutputTimedOut: true,
      durationMs: 30_000,
    });
    await expect(runCliAgent({ prompt: 'hi' })).rejects.toMatchObject({
      name: 'CliFailoverError',
      reason: 'timeout',
    });
  });

  it('throws CliFailoverError(auth) on auth failure stderr', async () => {
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockResolvedValue({
      exitCode: 1,
      reason: 'exit',
      stdout: '',
      stderr: 'Please log in via `claude login`.',
      noOutputTimedOut: false,
      durationMs: 100,
    });
    await expect(runCliAgent({ prompt: 'hi' })).rejects.toMatchObject({
      reason: 'auth',
    });
  });

  it('clears ANTHROPIC_API_KEY in spawned env', async () => {
    let capturedEnv: NodeJS.ProcessEnv = {};
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockImplementation(async (req) => {
      capturedEnv = req.env ?? {};
      return {
        exitCode: 0,
        reason: 'exit',
        stdout: '{"result":"ok"}',
        stderr: '',
        noOutputTimedOut: false,
        durationMs: 50,
      };
    });
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    await runCliAgent({ prompt: 'hi' });
    expect(capturedEnv.ANTHROPIC_API_KEY).toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('uses --resume args when cliSessionId given', async () => {
    let capturedArgv: string[] = [];
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockImplementation(async (req) => {
      capturedArgv = req.argv;
      return {
        exitCode: 0,
        reason: 'exit',
        stdout: '{"result":"ok"}',
        stderr: '',
        noOutputTimedOut: false,
        durationMs: 50,
      };
    });
    await runCliAgent({ prompt: 'hi', cliSessionId: 'sess1' });
    expect(capturedArgv).toContain('--resume');
    expect(capturedArgv).toContain('sess1');
  });
});
```

### 완료 조건

- 단위 테스트 5개 통과
- `clearEnv` 검증 — spawn 직전 env 에 `ANTHROPIC_API_KEY` 없음
- `--resume` 분기 검증

### 추정

**1 일**

---

## 밀스톤 F — ProviderAdapter Dual-Path 통합

### 목표

기존 `packages/agent/src/providers/anthropic.ts` (SDK 경로) 와 새 `claude-cli/runner.ts` 를 공통 `ProviderAdapter` 인터페이스 뒤에 dual-path 로 배치. config `provider: 'anthropic-sdk' | 'claude-cli'` 한 줄로 전환.

### 작업

**파일:**

- `packages/agent/src/providers/claude-cli/adapter.ts` (신규, ~150 LOC — `CliProviderAdapter` 클래스)
- `packages/agent/src/providers/index.ts` (수정, factory 등록)
- `packages/agent/src/providers/factory.ts` (신규 또는 기존 확장, ~40 LOC)
- `packages/config/src/schema.ts` (수정, ~5 LOC — `provider` config field)
- `packages/agent/test/providers/claude-cli/adapter.test.ts` (신규, ~80 LOC)

#### F1. CliProviderAdapter

```ts
// packages/agent/src/providers/claude-cli/adapter.ts

import type {
  ProviderAdapter,
  StreamCompletionRequest,
  StreamCompletionResponse,
} from '../adapter.js';
import { runCliAgent } from './runner.js';
import { CliFailoverError } from './errors.js';
import type { CliBackendConfig } from './types.js';

export interface CliProviderAdapterOptions {
  backend?: CliBackendConfig;
  defaultTimeoutMs?: number;
}

export class CliProviderAdapter implements ProviderAdapter {
  readonly id = 'claude-cli' as const;
  readonly supportsStreaming = false; // CLI 는 일괄 출력
  readonly supportsPromptCaching = false; // CLI 가 자동 처리, 우리가 제어 X
  readonly supportsToolUse = false; // CLI 측 도구는 비활성, FinClaw 측 도구는 server runner 가 처리

  constructor(private opts: CliProviderAdapterOptions = {}) {}

  async streamCompletion(req: StreamCompletionRequest): Promise<StreamCompletionResponse> {
    const result = await runCliAgent({
      prompt: extractPrompt(req),
      systemPrompt: req.systemPrompt,
      modelId: req.modelId,
      cliSessionId: req.metadata?.cliSessionId,
      timeoutMs: req.timeoutMs ?? this.opts.defaultTimeoutMs ?? 60_000,
      abortSignal: req.abortSignal,
      backend: this.opts.backend,
    });

    // SDK 와 동일한 응답 형식으로 변환
    return {
      text: result.text,
      finishReason: 'stop',
      usage: result.usage
        ? {
            inputTokens: result.usage.input ?? 0,
            outputTokens: result.usage.output ?? 0,
            cacheReadInputTokens: result.usage.cacheRead,
            cacheCreationInputTokens: result.usage.cacheWrite,
          }
        : undefined,
      metadata: {
        cliSessionId: result.sessionId,
        durationMs: result.durationMs,
      },
    };
  }
}

function extractPrompt(req: StreamCompletionRequest): string {
  // messages 배열을 단일 prompt 로 직렬화 (CLI 가 multi-turn 을 --resume 으로 처리하므로)
  return req.messages
    .map(
      (m) =>
        `${m.role === 'user' ? 'User' : 'Assistant'}: ${typeof m.content === 'string' ? m.content : ''}`,
    )
    .join('\n\n');
}
```

#### F2. Factory

```ts
// packages/agent/src/providers/factory.ts

import { AnthropicAdapter } from './anthropic.js';
import { CliProviderAdapter } from './claude-cli/adapter.js';
import type { ProviderAdapter } from './adapter.js';

export type ProviderId = 'anthropic-sdk' | 'claude-cli';

export interface ProviderConfig {
  id: ProviderId;
  apiKey?: string; // SDK 모드 전용
  cliBackend?: any; // CLI 모드 전용
  defaultTimeoutMs?: number;
}

export function createProviderAdapter(cfg: ProviderConfig): ProviderAdapter {
  switch (cfg.id) {
    case 'anthropic-sdk':
      if (!cfg.apiKey) throw new Error('ANTHROPIC_API_KEY required for anthropic-sdk provider');
      return new AnthropicAdapter({ apiKey: cfg.apiKey, defaultTimeoutMs: cfg.defaultTimeoutMs });
    case 'claude-cli':
      return new CliProviderAdapter({
        backend: cfg.cliBackend,
        defaultTimeoutMs: cfg.defaultTimeoutMs,
      });
    default: {
      const _exhaustive: never = cfg.id;
      throw new Error(`Unknown provider: ${_exhaustive}`);
    }
  }
}
```

#### F3. Config 분기

`packages/config/src/schema.ts`:

```ts
export const ConfigSchema = z.object({
  // ... 기존
  provider: z.enum(['anthropic-sdk', 'claude-cli']).default('anthropic-sdk'),
  cliBackend: z
    .object({
      command: z.string().optional(),
      timeoutMs: z.number().int().positive().optional(),
      // 사용자가 watchdog ratio override 가능
      watchdog: z
        .object({
          fresh: z
            .object({ noOutputTimeoutRatio: z.number().min(0.05).max(0.95).optional() })
            .optional(),
          resume: z
            .object({ noOutputTimeoutRatio: z.number().min(0.05).max(0.95).optional() })
            .optional(),
        })
        .optional(),
    })
    .optional(),
});
```

`packages/server/src/main.ts`:

```ts
// 기존:
// const provider = new AnthropicAdapter({ apiKey: cfg.anthropic.apiKey });

// 변경:
const provider = createProviderAdapter({
  id: cfg.provider,
  apiKey: process.env.ANTHROPIC_API_KEY,
  cliBackend: cfg.cliBackend
    ? {
        ...DEFAULT_CLAUDE_BACKEND,
        command: cfg.cliBackend.command ?? 'claude',
        reliability: cfg.cliBackend.watchdog ? { watchdog: cfg.cliBackend.watchdog } : undefined,
      }
    : undefined,
  defaultTimeoutMs: 60_000,
});

logger.info('provider.initialized', {
  event: 'provider.initialized',
  providerId: cfg.provider,
  // CLI 모드 시 streaming/caching/tool 미지원 경고
  ...(cfg.provider === 'claude-cli'
    ? { note: 'CLI mode: streaming/caching/tool_use disabled' }
    : {}),
});
```

#### F4. 테스트

```ts
import { describe, it, expect, vi } from 'vitest';
import * as runnerMod from '../../../src/providers/claude-cli/runner.js';
import { CliProviderAdapter } from '../../../src/providers/claude-cli/adapter.js';
import { createProviderAdapter } from '../../../src/providers/factory.js';

describe('CliProviderAdapter', () => {
  it('reports correct capabilities (no streaming, no caching, no tool_use)', () => {
    const a = new CliProviderAdapter();
    expect(a.id).toBe('claude-cli');
    expect(a.supportsStreaming).toBe(false);
    expect(a.supportsPromptCaching).toBe(false);
    expect(a.supportsToolUse).toBe(false);
  });

  it('serializes messages into prompt + delegates to runCliAgent', async () => {
    const spy = vi.spyOn(runnerMod, 'runCliAgent').mockResolvedValue({
      text: '응답',
      sessionId: 'sess1',
      usage: { input: 10, output: 5 },
      durationMs: 100,
    });
    const a = new CliProviderAdapter();
    const r = await a.streamCompletion({
      messages: [{ role: 'user', content: '안녕' }],
      modelId: 'sonnet',
    } as any);
    expect(r.text).toBe('응답');
    expect(r.usage?.inputTokens).toBe(10);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        prompt: expect.stringContaining('안녕'),
        modelId: 'sonnet',
      }),
    );
  });
});

describe('createProviderAdapter factory', () => {
  it('creates anthropic-sdk adapter', () => {
    const a = createProviderAdapter({ id: 'anthropic-sdk', apiKey: 'sk-test' });
    expect(a.id).toBe('anthropic');
  });
  it('creates claude-cli adapter', () => {
    const a = createProviderAdapter({ id: 'claude-cli' });
    expect(a.id).toBe('claude-cli');
  });
  it('throws for anthropic-sdk without apiKey', () => {
    expect(() => createProviderAdapter({ id: 'anthropic-sdk' })).toThrow(/API_KEY/);
  });
});
```

### 완료 조건

- 단위 테스트 6개 통과
- config `provider: 'claude-cli'` 시 main.ts 부트 로그에 명시
- SDK 모드 (기본값) 회귀 0

### 추정

**1 일**

---

## 밀스톤 G — agent_runs 의 cli_session_id 컬럼 + 인증 만료 fallback

### 목표

CLI 가 발급한 session_id 를 `agent_runs.cli_session_id` 에 저장하여 multi-turn 대화에서 `--resume` 사용. 인증 만료 (`auth` reason) 감지 시 SDK 모드로 자동 fallback (사용자 환경변수 `ANTHROPIC_API_KEY` 가 있으면).

### 작업

**파일:**

- `packages/storage/src/database.ts` (수정, SCHEMA_VERSION v10 → v11)
- `packages/storage/src/agent-runs.ts` (수정, ~10 LOC — cli_session_id 컬럼)
- `packages/agent/src/execution/runner.ts` (수정, ~30 LOC — fallback 로직)
- `packages/storage/test/migrations/v10-to-v11.test.ts` (신규, ~40 LOC)
- `packages/agent/test/execution/cli-fallback.test.ts` (신규, ~60 LOC)

#### G1. 마이그레이션 v10 → v11

```sql
ALTER TABLE agent_runs ADD COLUMN cli_session_id TEXT;
CREATE INDEX idx_agent_runs_cli_session ON agent_runs(cli_session_id) WHERE cli_session_id IS NOT NULL;
```

#### G2. Runner fallback

`packages/agent/src/execution/runner.ts` 의 provider.streamCompletion 호출 자리:

```ts
try {
  const response = await this.provider.streamCompletion(req);
  // 결과 metadata.cliSessionId 를 agent_runs 에 저장
  if (response.metadata?.cliSessionId) {
    await this.storage.updateAgentRun(this.runId, { cliSessionId: response.metadata.cliSessionId });
  }
  return response;
} catch (err) {
  // 인증 만료 fallback
  if (err instanceof CliFailoverError && err.reason === 'auth' && this.fallbackProvider) {
    this.logger.warn('provider.cli_auth_failed_fallback', {
      event: 'provider.cli_auth_failed_fallback',
      message: 'CLI auth expired, falling back to SDK. Run `claude login` to restore.',
    });
    // Discord 로 사용자 알림 (옵션)
    return this.fallbackProvider.streamCompletion(req);
  }
  throw err;
}
```

#### G3. 테스트

```ts
import { describe, it, expect, vi } from 'vitest';
// fallback 시나리오: CLI auth fail → SDK 사용
describe('CLI fallback to SDK on auth expiry', () => {
  it('falls back to SDK when CLI throws auth error', async () => {
    const cli = { streamCompletion: vi.fn().mockRejectedValue(new CliFailoverError('login expired', { reason: 'auth', provider: 'claude-cli', model: 'sonnet' })) };
    const sdk = { streamCompletion: vi.fn().mockResolvedValue({ text: 'sdk response', finishReason: 'stop' }) };
    const runner = new Runner({ provider: cli as any, fallbackProvider: sdk as any });
    const r = await runner.run({ ... });
    expect(r.text).toBe('sdk response');
    expect(cli.streamCompletion).toHaveBeenCalled();
    expect(sdk.streamCompletion).toHaveBeenCalled();
  });

  it('throws if CLI fails with non-auth reason', async () => {
    const cli = { streamCompletion: vi.fn().mockRejectedValue(new CliFailoverError('timeout', { reason: 'timeout', provider: 'claude-cli', model: 'sonnet' })) };
    const sdk = { streamCompletion: vi.fn() };
    const runner = new Runner({ provider: cli as any, fallbackProvider: sdk as any });
    await expect(runner.run(...)).rejects.toMatchObject({ reason: 'timeout' });
    expect(sdk.streamCompletion).not.toHaveBeenCalled();
  });
});
```

### 완료 조건

- 마이그레이션 v10 → v11 simulation 통과
- `cli_session_id` 가 multi-turn 시나리오에서 `--resume` 으로 전달됨 (e2e mock)
- auth fallback 단위 테스트 2개 통과

### 추정

**4 시간**

---

## 밀스톤 H — Live e2e (실제 claude CLI 검증)

### 목표

실제 `claude` CLI 가 설치되고 `claude login` 완료된 환경에서 e2e 검증. 4-tier 의 **live tier** 분류 — `pnpm test:live` 에서만 실행.

### 작업

**파일:**

- `packages/agent/test/providers/claude-cli/runner.live.test.ts` (신규, ~80 LOC)

#### H1. Live 시나리오

```ts
import { describe, it, expect } from 'vitest';
import { runCliAgent } from '../../../src/providers/claude-cli/runner.js';
import { execSync } from 'node:child_process';

const claudeAvailable = (() => {
  try {
    execSync('which claude', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!claudeAvailable)('runCliAgent (live)', () => {
  it('returns response from real claude CLI', async () => {
    const r = await runCliAgent({
      prompt: '한국어로 "안녕"이라고만 답해줘.',
      modelId: 'sonnet',
      timeoutMs: 60_000,
    });
    expect(r.text).toContain('안녕');
    expect(r.sessionId).toBeTruthy();
    expect(r.durationMs).toBeGreaterThan(0);
  }, 90_000);

  it('multi-turn with --resume', async () => {
    const turn1 = await runCliAgent({
      prompt: '내 이름은 testuser야.',
      modelId: 'sonnet',
      timeoutMs: 60_000,
    });
    expect(turn1.sessionId).toBeTruthy();

    const turn2 = await runCliAgent({
      prompt: '내 이름이 뭐야?',
      modelId: 'sonnet',
      cliSessionId: turn1.sessionId,
      timeoutMs: 60_000,
    });
    expect(turn2.text).toContain('testuser');
  }, 180_000);

  it('throws auth failover when ANTHROPIC_API_KEY clear works (sanity)', async () => {
    // ANTHROPIC_API_KEY 가 환경에 있어도 CLI 가 OAuth 로 동작하는지 검증
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-invalid';
    try {
      const r = await runCliAgent({
        prompt: 'say ok',
        modelId: 'sonnet',
        timeoutMs: 30_000,
      });
      // CLI 가 OAuth 로 정상 동작하면 여전히 응답 받음
      expect(r.text).toBeTruthy();
    } finally {
      if (original) process.env.ANTHROPIC_API_KEY = original;
      else delete process.env.ANTHROPIC_API_KEY;
    }
  }, 60_000);
});
```

#### H2. CI / 로컬 실행 가이드

`vitest.live.config.ts` 가 이미 존재 (Phase 26 산출). 본 테스트는 그 config 에서 실행. README 또는 docs 에 prerequisite 명시:

```
# Phase 32 live test
1. claude CLI 설치: https://docs.claude.com/en/docs/claude-code/setup
2. claude login (브라우저 OAuth)
3. pnpm test:live -- providers/claude-cli
```

### 완료 조건

- live test 3개가 `claude` CLI 설치된 환경에서 통과
- claude 미설치 환경에서는 `describe.skipIf` 로 자동 skip — `pnpm test:all` 회귀 0

### 추정

**4 시간**

---

## 통합 테스트

### 시나리오 1 — config 한 줄로 SDK ↔ CLI 전환

1. `config.json5` 에 `provider: 'claude-cli'` 추가
2. 서버 재시작 → 부트 로그에 `provider.initialized: claude-cli, note: streaming/caching/tool_use disabled` 확인
3. Discord 에서 메시지 1개 → CLI 응답 정상 반환 + agent_runs.cli_session_id 기록
4. config 를 `provider: 'anthropic-sdk'` 로 되돌림 → SDK 모드 정상 동작 (회귀 0)

### 시나리오 2 — Multi-turn 대화 (CLI --resume)

1. CLI 모드에서 메시지 1: "내 이름은 X야" → cli_session_id 발급
2. 메시지 2: "내 이름이 뭐야?" → 같은 session_id 로 `--resume`, "X" 라는 답
3. agent_runs 의 두 row 가 같은 cli_session_id 공유

### 시나리오 3 — 인증 만료 자동 fallback

1. `claude login` 토큰 의도적 만료 (또는 fixture 로 시뮬레이션)
2. CLI 호출 → `auth` reason 의 `CliFailoverError`
3. SDK fallback 자동 동작 (ANTHROPIC_API_KEY 환경변수 있을 때)
4. Discord 알림: "CLI 인증 만료 — `claude login` 실행해주세요"
5. 사용자가 `claude login` 후 재시도 → CLI 모드 복귀

---

## 완료 기준 (전체)

- [ ] 8 밀스톤 단위 테스트 통과 (총 ~36 테스트)
- [ ] 마이그레이션 v10 → v11 simulation 통과
- [ ] 통합 시나리오 3 모두 e2e 통과 (live tier 1 + mock 2)
- [ ] `pnpm test` (mock-only) 회귀 0
- [ ] `pnpm test:live -- providers/claude-cli` 통과 (claude CLI + login 환경)
- [ ] `pnpm typecheck` 0 에러, `pnpm lint` 0 위반
- [ ] config `provider: 'claude-cli'` 1주 실사용 후 review.md 작성

## 추정 합계

| 밀스톤                        | LOC                     | 시간             |
| ----------------------------- | ----------------------- | ---------------- |
| A. CLI Backend Config         | 150 + 50(test)          | 4h               |
| B. Watchdog Ratio             | 80 + 60(test)           | 2h               |
| C. Process Spawn + Queue      | 180 + 140(test)         | 1d               |
| D. JSON/JSONL Parsers         | 100 + 80(test)          | 3h               |
| E. runCliAgent Core           | 290 + 120(test)         | 1d               |
| F. ProviderAdapter Dual-Path  | 195 + 80(test)          | 1d               |
| G. agent_runs + auth fallback | 50 + 100(test)          | 4h               |
| H. Live e2e                   | 0 + 80(test)            | 4h               |
| 통합 검증 + review.md         | —                       | 1d               |
| **합계**                      | **~1,045 + 710 (test)** | **~6.5d (~1주)** |

OpenClaw 직접 이식 ~600 LOC + FinClaw 통합 ~400 LOC + 테스트 ~700 LOC.

## 환경 prerequisite

사용자가 본 Phase 사용 전 1회 수행:

```bash
# 1. claude CLI 설치 (npm 또는 직접 다운로드)
npm install -g @anthropic-ai/claude-cli  # 또는 공식 설치 가이드

# 2. OAuth 로그인 (브라우저로 Max 구독 인증)
claude login

# 3. 동작 확인
claude -p --output-format json "say ok"

# 4. FinClaw config
echo '{ "provider": "claude-cli" }' > config.json5
pnpm dev
```

## 트레이드오프 (사용자 인지 필요)

본 Phase 도입 시 잃는 것:

1. **Token-by-token streaming** — Discord 는 영향 작음 (typing indicator), Web UI 는 spinner 만 표시
2. **Prompt caching 제어** — CLI 가 자동 처리, hit/miss 비율 audit 불가 (cache trace 미도입 시)
3. **Tool_use protocol 직접 노출 X** — FinClaw 9-stage policy 가 CLI 외부에서 동작, CLI 내부 도구는 비활성. 도구 결과는 server runner 가 별도 처리 후 다음 turn 으로 전달
4. **Vision input** — claude CLI 의 `--image` 지원하지만 본 Phase 는 텍스트만 1차 (사용자 도메인 텍스트 위주, vision 은 후속)

본 Phase 도입으로 얻는 것:

1. **Claude Max 구독으로 API 비용 0원** — 핵심 동기
2. **Watchdog ratio + supervised spawn** — 행 걸린 프로세스 자동 회복
3. **Failover 분류** — auth/timeout/rate_limit 자동 변환 → 상위 fallback chain 호환
4. **Multi-turn 영속** — CLI session_id 가 agent_runs 에 남아 추적 가능

## 후속 (Phase 33+)

- **Streaming 단계 도입** — claude CLI 의 `--stream` 옵션이 stable 해지면 token-level 출력
- **Vision** — `--image` 인자 통합
- **`codex` backend 추가** — OpenAI Codex CLI 도 같은 패턴으로
- **Tool_use 통합** — CLI 측 도구 활성화 + FinClaw 9-stage policy 의 cross-CLI 적용

## 변경 이력

| 날짜       | 변경      | 사유                                                                         |
| ---------- | --------- | ---------------------------------------------------------------------------- |
| 2026-05-04 | 초기 작성 | Claude Max 구독 활용 → API 비용 0원 전환. SUMMARY-v2 의 ★★★★★ 가치 패턴 도입 |
