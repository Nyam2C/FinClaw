// packages/agent/src/runtime/cli-driver.ts
// Phase 46 M1: `claude -p` stream-json 드라이버. 격리 argv 를 강제하고 NDJSON 을 AgentEvent 로 매핑한다.
// 종료 규칙: result 를 받아도 stdout EOF + exit 까지 기다린 뒤 종료 이벤트를 정확히 1번 낸다 (I11).
import { spawn, type ChildProcessByStdio } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import type { FinClawLogger } from '@finclaw/infra';
import { classifyCliError } from '../providers/claude-cli/errors.js';
import type {
  AgentDriver,
  AgentErrorReason,
  AgentEvent,
  AgentUsage,
  DriverRequest,
} from './types.js';

export interface CliDriverOptions {
  /** config `cliBackend.command ?? 'claude'` */
  readonly command: string;
  /** 고정 중립 cwd (`~/.finclaw/agent`) — 생성 시 mkdir. */
  readonly cwd: string;
  readonly logger: FinClawLogger;
}

/** abort·timeout: SIGINT 후 이 시간 안에 안 끝나면 SIGKILL ([L4] §6 — SIGTERM 은 result 를 남기지 않음). */
const KILL_GRACE_MS = 2_000;
const AUTOCOMPACT_TOKENS = '200000';
const SESSION_NOT_FOUND_RE = /no conversation found/i;
const STDERR_TAIL_CHARS = 4_096;
/** [TQ1] 구 backends.ts 의 비항등 alias 1개 보존 (DEFAULT_MODEL id → CLI alias). 그 외 id 는 그대로 전달. */
const MODEL_ALIASES: Readonly<Record<string, string>> = { 'claude-sonnet-4-6': 'sonnet' };
const ZERO_USAGE: AgentUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

type Terminal = Extract<AgentEvent, { type: 'done' | 'error' }>;

/** mapStreamEvent 가 읽고 쓰는 run 단위 상태. stderr 는 드라이버가 채운다 (session_not_found 판정용). */
export interface StreamState {
  readonly runId: string;
  readonly expectMcp: boolean;
  cliSessionId: string;
  stderr: string;
}

/**
 * 격리 argv (plan §3-6). 호출자가 끌 수 없다.
 * 프롬프트는 `-p` 바로 뒤 [TQ14] — `--allowedTools`/`--mcp-config` 같은 가변 인자 옵션이 뒤따르는 위치 인자를 삼키지 않게.
 * (메인 프롬프트는 항상 `<context>`/`<recent_conversation>` 로 시작하므로 `-` 로 시작해 옵션으로 오인될 일이 없다.)
 * 금지: --dangerously-skip-permissions (N1) · --bare (OAuth 미로드) · --append-system-prompt (N2).
 */
export function buildCliArgs(req: DriverRequest): string[] {
  const args = [
    '-p',
    req.prompt,
    '--output-format',
    'stream-json',
    '--verbose',
    '--include-partial-messages',
    '--tools',
    '',
    '--strict-mcp-config',
    '--setting-sources',
    '',
    '--disable-slash-commands',
    '--system-prompt',
    req.systemPrompt,
    '--model',
    MODEL_ALIASES[req.model] ?? req.model,
    '--permission-prompts', // G5b — no-go 면 이 2줄 삭제
    'none',
  ];
  if (req.session.kind === 'new') {
    args.push('--session-id', req.session.id);
  } else if (req.session.kind === 'resume') {
    args.push('--resume', req.session.id);
  } else {
    args.push('--no-session-persistence');
  }
  if (req.mcp) {
    const mcpConfig = {
      mcpServers: {
        finclaw: {
          type: 'http',
          url: req.mcp.url,
          headers: { Authorization: `Bearer ${req.mcp.token}` },
        },
      },
    };
    args.push('--mcp-config', JSON.stringify(mcpConfig), '--allowedTools', 'mcp__finclaw__*');
  }
  if (req.maxTurns !== undefined) {
    args.push('--max-turns', String(req.maxTurns));
  }
  if (req.autocompact) {
    args.push('--autocompact', AUTOCOMPACT_TOKENS); // G5b — no-go 면 이 분기 삭제
  }
  return args;
}

/**
 * stream-json 원천 이벤트 1줄 → AgentEvent 0..n 개. 아는 type 만 처리하고 나머지는 무시 (R1 전방 호환):
 * system:status·thinking_tokens·compact_boundary·api_retry, rate_limit_event(status≠rejected),
 * stream_event 중 text_delta 외, 모르는 type.
 */
export function mapStreamEvent(raw: unknown, state: StreamState): AgentEvent[] {
  if (!isRecord(raw)) {
    return [];
  }
  switch (raw.type) {
    case 'system':
      return raw.subtype === 'init' ? mapInit(raw, state) : [];
    case 'stream_event': {
      const event = asRecord(raw.event);
      const delta = asRecord(event?.delta);
      const isMainText =
        event?.type === 'content_block_delta' &&
        delta?.type === 'text_delta' &&
        typeof delta.text === 'string' &&
        raw.parent_tool_use_id == null;
      return isMainText ? [{ type: 'text_delta', text: delta.text as string }] : [];
    }
    case 'assistant':
      return contentBlocks(raw).flatMap((b): AgentEvent[] =>
        b.type === 'tool_use' && typeof b.id === 'string' && typeof b.name === 'string'
          ? [{ type: 'tool_use', id: b.id, name: b.name, input: b.input }]
          : [],
      );
    case 'user':
      return contentBlocks(raw).flatMap((b): AgentEvent[] =>
        b.type === 'tool_result' && typeof b.tool_use_id === 'string'
          ? [{ type: 'tool_result', id: b.tool_use_id, isError: b.is_error === true }]
          : [],
      );
    case 'rate_limit_event':
      return asRecord(raw.rate_limit_info)?.status === 'rejected'
        ? [fail(state.runId, 'rate_limit', 'subscription rate limit rejected')]
        : [];
    case 'result':
      return [mapResult(raw, state)];
    default:
      return [];
  }
}

function mapInit(raw: Record<string, unknown>, state: StreamState): AgentEvent[] {
  if (typeof raw.session_id === 'string') {
    state.cliSessionId = raw.session_id;
  }
  const start: AgentEvent = {
    type: 'start',
    runId: state.runId,
    cliSessionId: state.cliSessionId,
    model: typeof raw.model === 'string' ? raw.model : '',
  };
  if (!state.expectMcp) {
    return [start];
  }
  const servers = Array.isArray(raw.mcp_servers) ? raw.mcp_servers : [];
  const finclaw = servers.map(asRecord).find((s) => s?.name === 'finclaw');
  if (finclaw?.status === 'connected') {
    return [start];
  }
  return [
    start,
    fail(
      state.runId,
      'mcp_unavailable',
      `finclaw MCP status=${String(finclaw?.status ?? 'missing')}`,
    ),
  ];
}

function mapResult(raw: Record<string, unknown>, state: StreamState): Terminal {
  const usage = toUsage(raw.usage);
  if (raw.subtype === 'success' && raw.is_error !== true) {
    return {
      type: 'done',
      runId: state.runId,
      cliSessionId: typeof raw.session_id === 'string' ? raw.session_id : state.cliSessionId,
      text: typeof raw.result === 'string' ? raw.result : '', // G2 — no-go 폴백은 M1-9 참고
      usage,
      ...(typeof raw.total_cost_usd === 'number' ? { costUsd: raw.total_cost_usd } : {}),
      durationMs: num(raw.duration_ms),
      numTurns: num(raw.num_turns),
    };
  }
  const errors = Array.isArray(raw.errors)
    ? raw.errors.filter((e): e is string => typeof e === 'string').join('\n')
    : '';
  const detail = [errors, typeof raw.result === 'string' ? raw.result : '', state.stderr].join(
    '\n',
  );
  let reason: AgentErrorReason;
  if (raw.subtype === 'error_max_turns') {
    reason = 'max_turns';
  } else if (
    raw.subtype === 'error_during_execution' &&
    raw.num_turns === 0 &&
    SESSION_NOT_FOUND_RE.test(detail)
  ) {
    reason = 'session_not_found'; // [L4] §1 실측 형태
  } else {
    reason = classifyCliError(detail);
  }
  return {
    type: 'error',
    runId: state.runId,
    reason,
    message: `claude result ${String(raw.subtype)}`,
    usage,
  };
}

export function createCliDriver(opts: CliDriverOptions): AgentDriver {
  mkdirSync(opts.cwd, { recursive: true });
  return (req) => runCli(opts, req);
}

async function* runCli(opts: CliDriverOptions, req: DriverRequest): AsyncGenerator<AgentEvent> {
  if (req.signal.aborted) {
    yield fail(req.runId, 'aborted', 'aborted before spawn');
    return;
  }
  let child: ChildProcessByStdio<null, Readable, Readable>;
  try {
    // stdin 은 ignore — 파이프로 열려 있으면 CLI 가 3s 대기한다 ([L4] §2). detached 아님 (G3 no-go 시 M1-9).
    child = spawn(opts.command, buildCliArgs(req), {
      cwd: opts.cwd,
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    yield fail(req.runId, 'spawn', errorMessage(err));
    return;
  }
  opts.logger.debug('cli.spawned', {
    event: 'cli.spawned',
    runId: req.runId,
    session: req.session.kind,
    model: req.model,
  });

  const state: StreamState = {
    runId: req.runId,
    expectMcp: req.mcp !== undefined,
    cliSessionId: req.session.kind === 'none' ? '' : req.session.id,
    stderr: '',
  };
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    state.stderr = (state.stderr + chunk).slice(-STDERR_TAIL_CHARS);
  });
  child.stdout.setEncoding('utf8'); // B11: 청크 경계의 멀티바이트를 StringDecoder 가 보존
  const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

  let spawnError: Error | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once('close', () => resolve());
    child.once('error', (err) => {
      spawnError = err; // ENOENT 등 — stdout 이 안 닫힐 수 있어 readline 을 직접 닫는다
      rl.close();
      resolve();
    });
  });

  let terminal: Terminal | undefined;
  let stopReason: 'aborted' | 'timeout' | undefined;
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const halt = (reason: 'aborted' | 'timeout'): void => {
    if (!terminal && !stopReason) {
      stopReason = reason; // 종료 이벤트를 이미 받았으면 그 이벤트를 유지하고 프로세스만 정리
    }
    if (killTimer) {
      return;
    }
    child.kill('SIGINT');
    killTimer = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS);
  };
  const onAbort = (): void => halt('aborted');
  req.signal.addEventListener('abort', onAbort, { once: true });
  let idleTimer = setTimeout(() => halt('timeout'), req.idleTimeoutMs);
  const overallTimer = setTimeout(() => halt('timeout'), req.overallTimeoutMs);

  try {
    for await (const line of rl) {
      clearTimeout(idleTimer); // 줄 수신마다 무출력 워치독 재설정
      idleTimer = setTimeout(() => halt('timeout'), req.idleTimeoutMs);
      // abort·종료 확정 이후 줄은 버리고 EOF 까지 드레인 ([L4] §6: SIGINT 후 부분 assistant·result 가 더 온다)
      if (stopReason || terminal || line.trim() === '') {
        continue;
      }
      let raw: unknown;
      try {
        raw = JSON.parse(line);
      } catch {
        // raw 줄은 로그 금지 (credential 섞임 위험) — 길이만
        opts.logger.debug('cli.stream.unparsable', {
          event: 'cli.stream.unparsable',
          length: line.length,
        });
        continue;
      }
      for (const ev of mapStreamEvent(raw, state)) {
        if (ev.type === 'done' || ev.type === 'error') {
          terminal = ev;
          if (asRecord(raw)?.type !== 'result') {
            halt('aborted'); // init(mcp_unavailable)·rate_limit 에서 확정된 종료 — CLI 가 계속 돌지 않게
          }
          break;
        }
        yield ev;
      }
    }
    await exited;
  } finally {
    clearTimeout(idleTimer);
    clearTimeout(overallTimer);
    clearTimeout(killTimer);
    req.signal.removeEventListener('abort', onAbort);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); // 소비자가 중간에 이탈(return) — 고아 방지
    }
  }

  let final: Terminal;
  if (stopReason) {
    final = fail(
      req.runId,
      stopReason,
      stopReason === 'timeout' ? 'CLI idle/overall timeout' : 'aborted',
    );
  } else if (terminal) {
    final = terminal;
  } else if (spawnError) {
    final = fail(req.runId, 'spawn', spawnError.message);
  } else {
    final = fail(req.runId, classifyCliError(state.stderr), 'CLI exited without result');
  }
  if (final.type === 'error' && final.reason !== 'aborted') {
    // raw stderr 는 로그에만 (Discord/WS 로는 reason·짧은 요약만 나간다)
    opts.logger.warn('cli.run.error', {
      event: 'cli.run.error',
      runId: req.runId,
      reason: final.reason,
      exitCode: child.exitCode,
      stderrTail: state.stderr.slice(-500),
    });
  }
  yield final;
}

function childEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1' };
  delete env.ANTHROPIC_API_KEY; // I1: 키가 있으면 -p 는 항상 키를 쓴다 → 구독 OAuth 강제
  delete env.ANTHROPIC_API_KEY_OLD; // 구 DEFAULT_CLAUDE_BACKEND.clearEnv 와 동일
  return env;
}

function fail(runId: string, reason: AgentErrorReason, message: string): Terminal {
  return { type: 'error', runId, reason, message };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return isRecord(v) ? v : undefined;
}

function contentBlocks(raw: Record<string, unknown>): Record<string, unknown>[] {
  const content = asRecord(raw.message)?.content;
  return Array.isArray(content) ? content.filter(isRecord) : [];
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function toUsage(v: unknown): AgentUsage {
  const u = asRecord(v);
  if (!u) {
    return ZERO_USAGE;
  }
  return {
    input: num(u.input_tokens),
    output: num(u.output_tokens),
    cacheRead: num(u.cache_read_input_tokens),
    cacheWrite: num(u.cache_creation_input_tokens),
  };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
