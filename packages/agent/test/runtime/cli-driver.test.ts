// packages/agent/test/runtime/cli-driver.test.ts
// Phase 46 M1: stream-json 드라이버 — argv 격리·이벤트 매핑·정확히 1 종료·abort/timeout·B11. mock-only.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { FinClawLogger } from '@finclaw/infra';
import { describe, expect, it, vi } from 'vitest';
import { buildCliArgs, createCliDriver } from '../../src/runtime/cli-driver.js';
import type { AgentEvent, DriverRequest } from '../../src/runtime/types.js';

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));

const TEXT = '안녕하세요! 테스트용 비서입니다, 무엇을 도와드릴까요?';
const TEXT_SESSION = '8a2494ed-5e2a-4f50-a83d-c2f2a972ec39';
/** 실측 sigint 픽스처: 16번째 줄(두 번째 text_delta)까지 받은 뒤 SIGINT 를 보냈다. */
const SIGINT_SPLIT = 16;
const FIXTURES = [
  'text-only',
  'tool-call',
  'resume-not-found',
  'sigint-abort',
  'rate-limit-allowed',
  'unknown-types',
  'mcp-unavailable',
] as const;

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: string[] = [];
  /** 기본: 어떤 시그널이든 즉시 종료. hang 시나리오는 테스트가 교체한다. */
  onSignal: (signal: string) => void = (signal) => this.finish(null, signal as NodeJS.Signals);

  kill(signal: string): boolean {
    this.signals.push(signal);
    this.onSignal(signal);
    return true;
  }

  lines(lines: readonly string[]): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    for (const line of lines) {
      this.stdout.write(`${line}\n`);
    }
  }

  finish(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }
    this.exitCode = code;
    this.signalCode = signal;
    this.stdout.end();
    this.stderr.end();
    setImmediate(() => this.emit('close', code, signal));
  }
}

const logger = {
  trace: vi.fn(),
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  fatal: vi.fn(),
  child: vi.fn(),
  flush: vi.fn(),
} as unknown as FinClawLogger;

function fixture(name: string): string[] {
  return readFileSync(new URL(`./fixtures/${name}.ndjson`, import.meta.url), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
}

function request(overrides: Partial<DriverRequest> = {}): DriverRequest {
  return {
    runId: 'run-1',
    prompt: '<context>\n현재 시각: 2026-11-26T10:00:00+09:00 (Asia/Seoul)\n</context>\n\n안녕',
    systemPrompt: 'SYS',
    model: 'haiku',
    session: { kind: 'new', id: '11111111-1111-4111-8111-111111111111' },
    idleTimeoutMs: 120_000,
    overallTimeoutMs: 300_000,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** spawn 이 child 를 돌려준 다음 tick(드라이버가 리스너를 붙인 뒤)에 script 실행. */
function serve(script: (child: FakeChild) => void): FakeChild {
  const child = new FakeChild();
  vi.mocked(spawn).mockImplementation(() => {
    setImmediate(() => script(child));
    return child as never;
  });
  return child;
}

function replay(name: string, opts: { stderr?: string } = {}): FakeChild {
  return serve((c) => {
    if (opts.stderr) {
      c.stderr.write(opts.stderr);
    }
    c.lines(fixture(name));
    c.finish(0);
  });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of events) {
    out.push(ev);
  }
  return out;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function driver() {
  return createCliDriver({ command: 'claude', cwd: mkdtempSync(join(tmpdir(), 'drv-')), logger });
}

const types = (events: AgentEvent[]) => events.map((e) => e.type);
const terminals = (events: AgentEvent[]) =>
  events.filter((e) => e.type === 'done' || e.type === 'error');
const deltas = (events: AgentEvent[]) =>
  events.flatMap((e) => (e.type === 'text_delta' ? [e.text] : []));
const valueOf = (args: string[], flag: string) => args[args.indexOf(flag) + 1];

describe('buildCliArgs — 격리 argv (plan §3-6)', () => {
  it('격리 플래그가 모두 있고 금지 플래그는 없다', () => {
    const req = request();
    const args = buildCliArgs(req);
    expect(args.slice(0, 2)).toEqual(['-p', req.prompt]);
    expect(valueOf(args, '--output-format')).toBe('stream-json');
    expect(valueOf(args, '--tools')).toBe('');
    expect(valueOf(args, '--setting-sources')).toBe('');
    expect(valueOf(args, '--system-prompt')).toBe('SYS');
    expect(valueOf(args, '--model')).toBe('haiku');
    expect(valueOf(args, '--permission-prompts')).toBe('none');
    expect(args).toEqual(
      expect.arrayContaining([
        '--verbose',
        '--include-partial-messages',
        '--strict-mcp-config',
        '--disable-slash-commands',
      ]),
    );
    for (const banned of ['--dangerously-skip-permissions', '--append-system-prompt', '--bare']) {
      expect(args).not.toContain(banned);
    }
  });

  it('session 3종을 각각의 플래그로 낸다', () => {
    const id = '22222222-2222-4222-8222-222222222222';
    expect(valueOf(buildCliArgs(request({ session: { kind: 'new', id } })), '--session-id')).toBe(
      id,
    );
    expect(valueOf(buildCliArgs(request({ session: { kind: 'resume', id } })), '--resume')).toBe(
      id,
    );
    const none = buildCliArgs(request({ session: { kind: 'none' } }));
    expect(none).toContain('--no-session-persistence');
    expect(none).not.toContain('--session-id');
    expect(none).not.toContain('--resume');
  });

  it('mcp 가 있으면 http MCP + Bearer + allowedTools, 없으면 둘 다 없다', () => {
    const args = buildCliArgs(request({ mcp: { url: 'http://127.0.0.1:3000/mcp', token: 'tok' } }));
    expect(JSON.parse(valueOf(args, '--mcp-config'))).toEqual({
      mcpServers: {
        finclaw: {
          type: 'http',
          url: 'http://127.0.0.1:3000/mcp',
          headers: { Authorization: 'Bearer tok' },
        },
      },
    });
    expect(valueOf(args, '--allowedTools')).toBe('mcp__finclaw__*');
    const bare = buildCliArgs(request());
    expect(bare).not.toContain('--mcp-config');
    expect(bare).not.toContain('--allowedTools');
  });

  it('maxTurns·autocompact 는 지정할 때만', () => {
    const args = buildCliArgs(request({ maxTurns: 10, autocompact: true }));
    expect(valueOf(args, '--max-turns')).toBe('10');
    expect(valueOf(args, '--autocompact')).toBe('200000');
    const plain = buildCliArgs(request());
    expect(plain).not.toContain('--max-turns');
    expect(plain).not.toContain('--autocompact');
  });

  it('DEFAULT_MODEL id 만 alias 로 바꾸고 나머지는 그대로 [TQ1]', () => {
    expect(valueOf(buildCliArgs(request({ model: 'claude-sonnet-4-6' })), '--model')).toBe(
      'sonnet',
    );
    expect(valueOf(buildCliArgs(request({ model: 'claude-opus-4-7' })), '--model')).toBe(
      'claude-opus-4-7',
    );
  });
});

describe('createCliDriver — 스트림 매핑', () => {
  it('spawn: stdin ignore, 고정 cwd, env 에 ANTHROPIC_API_KEY 없음 + auto memory off', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    try {
      replay('text-only');
      await collect(driver()(request()));
      const [command, , options] = vi.mocked(spawn).mock.calls[0] as unknown as [
        string,
        string[],
        { cwd: string; env: NodeJS.ProcessEnv; stdio: unknown },
      ];
      expect(command).toBe('claude');
      expect(options.stdio).toEqual(['ignore', 'pipe', 'pipe']);
      expect(options.cwd).toContain('drv-');
      expect(options.env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(options.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe('1');
    } finally {
      delete process.env.ANTHROPIC_API_KEY;
    }
  });

  it('text-only: start → text_delta×7 → done(result.result·usage·cost)', async () => {
    replay('text-only');
    const events = await collect(driver()(request()));
    expect(types(events)).toEqual(['start', ...Array(7).fill('text_delta'), 'done']);
    expect(events[0]).toEqual({
      type: 'start',
      runId: 'run-1',
      cliSessionId: TEXT_SESSION,
      model: 'claude-haiku-5-5',
    });
    expect(deltas(events).join('')).toBe(TEXT);
    expect(events.at(-1)).toEqual({
      type: 'done',
      runId: 'run-1',
      cliSessionId: TEXT_SESSION,
      text: TEXT,
      usage: { input: 2, output: 35, cacheRead: 0, cacheWrite: 659 },
      costUsd: 0.0001495,
      durationMs: 1839,
      numTurns: 1,
    });
  });

  it('rate_limit_event status=allowed 는 무시된다 (overageStatus=rejected 함정 포함)', async () => {
    replay('text-only');
    const plain = await collect(driver()(request()));
    replay('rate-limit-allowed');
    const withAllowed = await collect(driver()(request()));
    expect(withAllowed).toEqual(plain);
  });

  it('tool-call: tool_use(id·name·input) → tool_result(isError=false) → text×5 → done(numTurns=2)', async () => {
    replay('tool-call');
    const events = await collect(
      driver()(request({ mcp: { url: 'http://127.0.0.1:3000/mcp', token: 't' } })),
    );
    expect(types(events)).toEqual([
      'start',
      'tool_use',
      'tool_result',
      ...Array(5).fill('text_delta'),
      'done',
    ]);
    expect(events[1]).toEqual({
      type: 'tool_use',
      id: 'toolu_01MvZWGmowvEkv23xHWup1U8',
      name: 'mcp__finclaw__get_price',
      input: { symbol: 'AAPL' },
    });
    expect(events[2]).toEqual({
      type: 'tool_result',
      id: 'toolu_01MvZWGmowvEkv23xHWup1U8',
      isError: false,
    });
    expect(events.at(-1)).toMatchObject({ type: 'done', numTurns: 2 });
  });

  it('resume-not-found → error{session_not_found} (start 없음)', async () => {
    replay('resume-not-found', {
      stderr: 'No conversation found with session ID: 11111111-2222-4333-8444-555555555555\n',
    });
    const events = await collect(
      driver()(
        request({ session: { kind: 'resume', id: '11111111-2222-4333-8444-555555555555' } }),
      ),
    );
    expect(events).toEqual([
      expect.objectContaining({ type: 'error', reason: 'session_not_found', runId: 'run-1' }),
    ]);
  });

  it('unknown-types: 모르는 type·system 하위타입·비 text delta·깨진 JSON 줄은 무시', async () => {
    replay('unknown-types');
    const events = await collect(driver()(request()));
    expect(types(events)).toEqual(['start', 'text_delta', 'done']);
    expect(deltas(events)).toEqual(['안녕']);
  });

  it('result error_max_turns → error{max_turns}', async () => {
    serve((c) => {
      c.lines([
        fixture('text-only')[0],
        '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":10,"session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","usage":{"input_tokens":1,"output_tokens":1}}',
      ]);
      c.finish(0);
    });
    const events = await collect(driver()(request({ maxTurns: 10 })));
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'max_turns' });
  });

  it('미인증 result(subtype=success, is_error=true) → error{auth} (실측 2.1.332 문구)', async () => {
    serve((c) => {
      c.lines([
        fixture('text-only')[0],
        '{"type":"result","subtype":"success","is_error":true,"num_turns":1,"result":"Not logged in · Please run /login","session_id":"8a2494ed-5e2a-4f50-a83d-c2f2a972ec39","usage":{"input_tokens":0,"output_tokens":0}}',
      ]);
      c.finish(1);
    });
    const events = await collect(driver()(request()));
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'auth' });
  });

  it('B11: 한글 멀티바이트가 청크 경계에서 깨지지 않는다', async () => {
    serve((c) => {
      const lines = fixture('text-only');
      const head = Buffer.from(`${lines.slice(0, 5).join('\n')}\n`); // 5번째 줄 = "안녕하세요!" delta
      const cut = head.indexOf(Buffer.from('녕')) + 1; // '녕'(3바이트) 한가운데
      c.stdout.write(head.subarray(0, cut));
      c.stdout.write(head.subarray(cut));
      c.lines(lines.slice(5));
      c.finish(0);
    });
    const events = await collect(driver()(request()));
    expect(deltas(events)[0]).toBe('안녕하세요!');
  });
});

describe('createCliDriver — 정확히 1 종료 (I11)', () => {
  it.each(FIXTURES)('%s: 종료 이벤트가 정확히 1개이고 마지막이다', async (name) => {
    replay(name);
    const events = await collect(driver()(request()));
    expect(terminals(events)).toHaveLength(1);
    expect(['done', 'error']).toContain(events.at(-1)?.type);
  });

  it('spawn ENOENT → error{spawn}', async () => {
    serve((c) =>
      c.emit('error', Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' })),
    );
    const events = await collect(driver()(request()));
    expect(events).toEqual([expect.objectContaining({ type: 'error', reason: 'spawn' })]);
  });

  it('result 없이 EOF → error{unknown}', async () => {
    serve((c) => {
      c.lines(fixture('text-only').slice(0, 6));
      c.finish(1);
    });
    const events = await collect(driver()(request()));
    expect(terminals(events)).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'unknown' });
  });

  it('이미 abort 된 signal → spawn 없이 error{aborted}', async () => {
    const ac = new AbortController();
    ac.abort();
    vi.mocked(spawn).mockClear();
    const events = await collect(driver()(request({ signal: ac.signal })));
    expect(events).toEqual([expect.objectContaining({ type: 'error', reason: 'aborted' })]);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe('createCliDriver — abort · timeout', () => {
  it('abort → SIGINT, 2s 안 끝나면 SIGKILL, 이후 도착한 delta 는 버리고 error{aborted} 1회', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lines = fixture('sigint-abort');
    const ac = new AbortController();
    const child = serve((c) => c.lines(lines.slice(0, SIGINT_SPLIT)));
    child.onSignal = (signal) => {
      if (signal === 'SIGKILL') {
        child.finish(null, 'SIGKILL');
      }
    };
    const pending = collect(driver()(request({ signal: ac.signal })));
    await settle();
    ac.abort();
    expect(child.signals).toEqual(['SIGINT']);
    child.lines([...lines.slice(SIGINT_SPLIT), fixture('text-only')[8]]); // 시그널 후 도착분
    await settle();
    await vi.advanceTimersByTimeAsync(2_000);
    const events = await pending;
    expect(child.signals).toEqual(['SIGINT', 'SIGKILL']);
    expect(types(events)).toEqual(['start', ...Array(2).fill('text_delta'), 'error']);
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'aborted' });
  });

  it('SIGINT 로 grace 안에 끝나면 SIGKILL 을 보내지 않는다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const ac = new AbortController();
    const child = serve((c) => c.lines(fixture('text-only').slice(0, 6)));
    const pending = collect(driver()(request({ signal: ac.signal })));
    await settle();
    ac.abort();
    const events = await pending;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(child.signals).toEqual(['SIGINT']);
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'aborted' });
  });

  it('무출력 idleTimeoutMs 경과 → SIGINT + error{timeout}', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const child = serve((c) => c.lines([fixture('text-only')[0]]));
    const pending = collect(driver()(request({ idleTimeoutMs: 1_000 })));
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    const events = await pending;
    expect(child.signals[0]).toBe('SIGINT');
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'timeout' });
  });

  it('줄이 계속 와도 overallTimeoutMs 경과 → error{timeout}', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const [init, status] = fixture('text-only');
    serve((c) => {
      c.lines([init]);
      const tick = (): void => {
        c.lines([status]);
        setTimeout(tick, 600);
      };
      setTimeout(tick, 600);
    });
    const pending = collect(driver()(request({ idleTimeoutMs: 1_000, overallTimeoutMs: 2_500 })));
    await settle();
    await vi.advanceTimersByTimeAsync(2_500);
    const events = await pending;
    expect(events.at(-1)).toMatchObject({ type: 'error', reason: 'timeout' });
  });

  it('줄 수신마다 idle 타이머가 재설정된다', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lines = fixture('text-only');
    const child = serve((c) => {
      c.lines([lines[0]]);
      setTimeout(() => c.lines([lines[1]]), 600);
      setTimeout(() => c.lines([lines[2]]), 1_200);
      setTimeout(() => {
        c.lines(lines.slice(3));
        c.finish(0);
      }, 1_800);
    });
    const pending = collect(driver()(request({ idleTimeoutMs: 1_000 })));
    await settle();
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(600);
      await settle();
    }
    const events = await pending;
    expect(child.signals).toEqual([]);
    expect(events.at(-1)).toMatchObject({ type: 'done' });
  });

  it('rate_limit_event status=rejected → error{rate_limit} + 프로세스 정리', async () => {
    const rejected = fixture('rate-limit-allowed').map((l) =>
      l.replace('"status":"allowed"', '"status":"rejected"'),
    );
    const child = serve((c) => c.lines(rejected)); // 스스로 안 끝남 → 드라이버가 SIGINT
    const events = await collect(driver()(request()));
    expect(terminals(events)).toEqual([
      expect.objectContaining({ type: 'error', reason: 'rate_limit' }),
    ]);
    expect(child.signals[0]).toBe('SIGINT');
  });

  it('init 에서 finclaw MCP 가 connected 가 아니면 start → error{mcp_unavailable} + 정리', async () => {
    // 실측: status=failed 여도 CLI 는 MCP 없이 턴을 계속 진행한다 → 드라이버가 init 에서 끊어야 한다
    const child = serve((c) => c.lines(fixture('mcp-unavailable')));
    const events = await collect(
      driver()(request({ mcp: { url: 'http://127.0.0.1:3000/mcp', token: 't' } })),
    );
    expect(types(events)).toEqual(['start', 'error']);
    expect(events.at(-1)).toMatchObject({ reason: 'mcp_unavailable' });
    expect(child.signals[0]).toBe('SIGINT');
  });

  it('소비자가 중간에 이탈하면 child 를 SIGKILL 로 정리한다', async () => {
    const child = serve((c) => c.lines(fixture('text-only').slice(0, 6)));
    child.onSignal = (signal) => {
      if (signal === 'SIGKILL') {
        child.finish(null, 'SIGKILL');
      }
    };
    for await (const ev of driver()(request())) {
      if (ev.type === 'start') {
        break;
      }
    }
    expect(child.signals).toContain('SIGKILL');
  });
});
