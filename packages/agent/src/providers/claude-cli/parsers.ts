// packages/agent/src/providers/claude-cli/parsers.ts

import type { CliBackendConfig } from './types.js';

export interface CliUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
  /** Phase 40 E: claude CLI result 최상위 total_cost_usd (구독 차감 비용, USD). */
  costUsd?: number;
}

export interface CliOutput {
  text: string;
  sessionId?: string;
  usage?: CliUsage;
}

/** 단일 JSON object 출력 (claude CLI 의 --output-format json) */
export function parseCliJson(stdout: string, backend: CliBackendConfig): CliOutput | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (!parsed || typeof parsed !== 'object') {
    return undefined;
  }

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
  if (!lines.length) {
    return undefined;
  }

  let text = '';
  let sessionId: string | undefined;
  let usage: CliUsage | undefined;

  for (const line of lines) {
    let obj: Record<string, unknown> | undefined;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object') {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      continue;
    }
    if (!obj) {
      continue;
    }

    const t = pickText(obj);
    if (t) {
      text = text ? `${text}\n${t}` : t;
    }

    const sid = pickSessionId(obj, backend);
    if (sid && !sessionId) {
      sessionId = sid;
    }

    const u = pickUsage(obj);
    if (u) {
      usage = mergeUsage(usage, u);
    }
  }

  return text ? { text, sessionId, usage } : undefined;
}

function isTextBlock(c: unknown): c is { type: string; text: string } {
  return (
    typeof c === 'object' &&
    c !== null &&
    (c as Record<string, unknown>).type === 'text' &&
    typeof (c as Record<string, unknown>).text === 'string'
  );
}

function pickText(obj: Record<string, unknown>): string {
  // claude CLI: { type: 'result', result: '...', is_error: false }
  if (typeof obj.result === 'string') {
    return obj.result;
  }
  // 일반: { content: [{ type: 'text', text: '...' }] } 또는 { text: '...' }
  if (typeof obj.text === 'string') {
    return obj.text;
  }
  if (Array.isArray(obj.content)) {
    return obj.content
      .filter(isTextBlock)
      .map((c) => c.text)
      .join('\n');
  }
  if (typeof obj.message === 'string') {
    return obj.message;
  }
  return '';
}

function pickSessionId(
  obj: Record<string, unknown>,
  backend: CliBackendConfig,
): string | undefined {
  for (const field of backend.sessionIdFields ?? []) {
    const v = obj[field];
    if (typeof v === 'string' && v.trim()) {
      return v.trim();
    }
  }
  return undefined;
}

function pickUsage(obj: Record<string, unknown>): CliUsage | undefined {
  const usage = obj.usage;
  // Phase 40 E: total_cost_usd 는 result 최상위 (usage 의 형제) — 구독 차감 비용.
  const costUsd =
    typeof obj.total_cost_usd === 'number' && Number.isFinite(obj.total_cost_usd)
      ? (obj.total_cost_usd as number)
      : undefined;
  if (!usage || typeof usage !== 'object') {
    return costUsd !== undefined ? { costUsd } : undefined;
  }
  const u = usage as Record<string, unknown>;
  const num = (k: string) =>
    typeof u[k] === 'number' && Number.isFinite(u[k]) ? (u[k] as number) : undefined;
  return {
    input: num('input_tokens') ?? num('input'),
    output: num('output_tokens') ?? num('output'),
    cacheRead: num('cache_read_input_tokens') ?? num('cacheRead'),
    cacheWrite: num('cache_creation_input_tokens') ?? num('cacheWrite'),
    total: num('total_tokens') ?? num('total'),
    costUsd,
  };
}

function mergeUsage(a: CliUsage | undefined, b: CliUsage): CliUsage {
  if (!a) {
    return b;
  }
  return {
    input: (a.input ?? 0) + (b.input ?? 0),
    output: (a.output ?? 0) + (b.output ?? 0),
    cacheRead: (a.cacheRead ?? 0) + (b.cacheRead ?? 0),
    cacheWrite: (a.cacheWrite ?? 0) + (b.cacheWrite ?? 0),
    total: (a.total ?? 0) + (b.total ?? 0),
    costUsd:
      a.costUsd !== undefined || b.costUsd !== undefined
        ? (a.costUsd ?? 0) + (b.costUsd ?? 0)
        : undefined,
  };
}
