// packages/agent/test/runtime/cli-driver.live.test.ts
// Phase 46 M1 live (수동 · CI 제외): G3 SIGINT 정리 · G4 resume 실패 형태 · G5b 플래그 수용 · G6 resume 첫 delta 지연 · 격리.
import { execSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import type { FinClawLogger } from '@finclaw/infra';
import { beforeAll, describe, expect, it } from 'vitest';
import { buildCliArgs, createCliDriver } from '../../src/runtime/cli-driver.js';
import type { AgentEvent, DriverRequest } from '../../src/runtime/types.js';

const claudeAvailable = (() => {
  try {
    execSync('which claude', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

const noop = (): void => {};
const logger = {
  trace: noop,
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
  fatal: noop,
  child: () => logger,
  flush: async () => {},
} as unknown as FinClawLogger;

// R9: test-env.ts 가 HOME 을 tmpdir 로 바꾼다. 실측(2.1.332, macOS): 격리 HOME 에서는
// result{subtype:success,is_error:true,result:"Not logged in · Please run /login"} → 실제 HOME 으로 되돌린다
// (setup 의 beforeAll 이 모듈 로드 뒤에 돌므로 beforeAll 안에서).
beforeAll(() => {
  process.env.HOME = userInfo().homedir;
});
const cwd = mkdtempSync(join(tmpdir(), 'finclaw-live-agent-'));
const driver = createCliDriver({ command: 'claude', cwd, logger });

function req(overrides: Partial<DriverRequest>): DriverRequest {
  return {
    runId: randomUUID(),
    prompt: '<context>\n현재 시각: live\n</context>\n\n"안녕"이라고만 답해.',
    systemPrompt: '짧게 답한다.',
    model: 'haiku',
    session: { kind: 'none' },
    idleTimeoutMs: 60_000,
    overallTimeoutMs: 90_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
  }
  return out;
}

/** 드라이버를 거치지 않고 argv 그대로 1회 실행 — 마지막 result 줄과 init 줄을 돌려준다. */
function runRaw(args: string[]): {
  init?: Record<string, unknown>;
  result?: Record<string, unknown>;
  status: number | null;
} {
  const env = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  delete env.ANTHROPIC_API_KEY;
  const out = spawnSync('claude', args, { cwd, env, encoding: 'utf8', timeout: 90_000 });
  const parsed = out.stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
  return {
    init: parsed.find((p) => p.type === 'system' && p.subtype === 'init'),
    result: parsed.findLast((p) => p.type === 'result'),
    status: out.status,
  };
}

describe.skipIf(!claudeAvailable)('cli-driver (live, haiku)', () => {
  it('격리 + 기본 턴: init tools=[] · 플러그인 builtin 만 · skills=[] · done.text 비어 있지 않음', async () => {
    const raw = runRaw(buildCliArgs(req({})));
    console.log(
      '[isolation] tools=%j skills=%j plugins=%j',
      raw.init?.tools,
      raw.init?.skills,
      raw.init?.plugins,
    );
    expect(raw.init?.tools).toEqual([]);
    expect(raw.init?.skills).toEqual([]);
    for (const p of (raw.init?.plugins as Array<{ path: string }> | undefined) ?? []) {
      expect(p.path).toBe('builtin');
    }
    const events = await collect(driver(req({})));
    expect(events[0]?.type).toBe('start');
    expect(events.at(-1)).toMatchObject({ type: 'done' });
    expect((events.at(-1) as { text: string }).text.length).toBeGreaterThan(0);
  }, 120_000);

  it('G5b: --permission-prompts none · --autocompact 200000 를 각각 수용', () => {
    const base = buildCliArgs(req({})).filter(
      (a, i, all) => a !== '--permission-prompts' && all[i - 1] !== '--permission-prompts',
    );
    for (const extra of [
      ['--permission-prompts', 'none'],
      ['--autocompact', '200000'],
    ]) {
      const raw = runRaw([...base, ...extra]);
      console.log(
        '[G5b] %s → status=%s subtype=%s',
        extra.join(' '),
        raw.status,
        raw.result?.subtype,
      );
      expect(raw.result?.subtype).toBe('success');
    }
  }, 240_000);

  it('G4: 없는 uuid resume → error{session_not_found}', async () => {
    const events = await collect(driver(req({ session: { kind: 'resume', id: randomUUID() } })));
    console.log('[G4] %j', events.at(-1));
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'session_not_found' });
  }, 60_000);

  it('G3: 스트리밍 중 abort → 2.5s 안 종료 + 고아 0', async () => {
    const marker = `g3-${randomUUID()}`;
    const ac = new AbortController();
    const startedAt = Date.now();
    let abortedAt = 0;
    const events: AgentEvent[] = [];
    let seen = 0;
    for await (const ev of driver(
      req({
        prompt: `<context>\n${marker}\n</context>\n\n1부터 200까지 숫자를 한 줄에 하나씩 한글로 써줘`,
        signal: ac.signal,
      }),
    )) {
      events.push(ev);
      if (ev.type === 'text_delta' && ++seen === 5) {
        abortedAt = Date.now();
        ac.abort();
      }
    }
    const exitMs = Date.now() - abortedAt;
    await new Promise((r) => setTimeout(r, 500));
    const orphans = spawnSync('pgrep', ['-f', marker], { encoding: 'utf8' }).stdout.trim();
    console.log(
      '[G3] exitAfterAbortMs=%d totalMs=%d orphans=%j last=%j',
      exitMs,
      Date.now() - startedAt,
      orphans,
      events.at(-1),
    );
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'aborted' });
    expect(exitMs).toBeLessThan(2_500);
    expect(orphans).toBe('');
  }, 90_000);

  it('G6: resume 턴 첫 text_delta 지연 p50 (측정만)', async () => {
    const id = randomUUID();
    await collect(
      driver(
        req({
          session: { kind: 'new', id },
          prompt: '<context>\n-\n</context>\n\n내 이름은 자두야. "응"이라고만 답해.',
        }),
      ),
    );
    const samples: number[] = [];
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      let first = 0;
      for await (const ev of driver(
        req({
          session: { kind: 'resume', id },
          prompt: '<context>\n-\n</context>\n\n내 이름이 뭐지? 이름만.',
        }),
      )) {
        if (ev.type === 'text_delta' && first === 0) {
          first = Date.now() - t0;
        }
      }
      samples.push(first);
    }
    const p50 = samples.toSorted((a, b) => a - b)[1];
    console.log('[G6] resume first text_delta ms samples=%j p50=%d', samples, p50);
    expect(p50).toBeGreaterThan(0);
  }, 240_000);
});
