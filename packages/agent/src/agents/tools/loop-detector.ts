// packages/agent/src/agents/tools/loop-detector.ts
// OpenClaw src/agents/tool-loop-detection.ts:1-360 중 generic_repeat + global_circuit_breaker 발췌.

import { createHash } from 'node:crypto';

export const TOOL_CALL_HISTORY_SIZE = 30;
export const WARNING_THRESHOLD = 10;
export const CRITICAL_THRESHOLD = 20;
export const GLOBAL_CIRCUIT_BREAKER_THRESHOLD = 30;

export type LoopDetectorKind = 'generic_repeat' | 'global_circuit_breaker';

export type LoopDetectionResult =
  | { stuck: false }
  | {
      stuck: true;
      level: 'warning' | 'critical';
      detector: LoopDetectorKind;
      count: number;
      message: string;
      warningKey?: string;
    };

export interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  resultHash?: string;
}

// === stableStringify + digestStable — OpenClaw tool-loop-detection.ts:113-148 그대로 ===

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).toSorted();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function digestStable(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function hashToolCall(toolName: string, params: unknown): string {
  return `${toolName}:${digestStable(params)}`;
}

export function hashToolResult(result: unknown, error: unknown): string | undefined {
  if (error !== undefined) {
    return `error:${digestStable(error instanceof Error ? error.message : String(error))}`;
  }
  if (result === undefined || result === null) {
    return undefined;
  }
  return digestStable(result);
}

// === getNoProgressStreak — OpenClaw tool-loop-detection.ts:235-263 ===

function getNoProgressStreak(
  history: ToolCallRecord[],
  toolName: string,
  argsHash: string,
): { count: number; latestResultHash?: string } {
  let streak = 0;
  let latestResultHash: string | undefined;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const record = history[i];
    if (!record || record.toolName !== toolName || record.argsHash !== argsHash) {
      continue;
    }
    if (typeof record.resultHash !== 'string' || !record.resultHash) {
      continue;
    }
    if (!latestResultHash) {
      latestResultHash = record.resultHash;
      streak = 1;
      continue;
    }
    if (record.resultHash !== latestResultHash) {
      break;
    }
    streak += 1;
  }
  return { count: streak, latestResultHash };
}

// === detectToolCallLoop — 2 detector 단순화 ===

export function detectToolCallLoop(
  history: ToolCallRecord[],
  toolName: string,
  params: unknown,
): LoopDetectionResult {
  const argsHash = hashToolCall(toolName, params);
  const noProgress = getNoProgressStreak(history, toolName, argsHash);

  if (noProgress.count >= GLOBAL_CIRCUIT_BREAKER_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'global_circuit_breaker',
      count: noProgress.count,
      message: `CRITICAL: ${toolName} repeated ${noProgress.count} times with no progress. Session blocked.`,
      warningKey: `global:${toolName}:${argsHash}:${noProgress.latestResultHash ?? 'none'}`,
    };
  }

  if (noProgress.count >= CRITICAL_THRESHOLD) {
    return {
      stuck: true,
      level: 'critical',
      detector: 'generic_repeat',
      count: noProgress.count,
      message: `Tool "${toolName}" called ${noProgress.count} times with identical args+result. Possible infinite loop.`,
      warningKey: `repeat:${toolName}:${argsHash}`,
    };
  }

  if (noProgress.count >= WARNING_THRESHOLD) {
    return {
      stuck: true,
      level: 'warning',
      detector: 'generic_repeat',
      count: noProgress.count,
      message: `Tool "${toolName}" called ${noProgress.count} times with no progress.`,
      warningKey: `repeat:${toolName}:${argsHash}`,
    };
  }

  return { stuck: false };
}

export function appendHistory(
  history: ToolCallRecord[],
  record: ToolCallRecord,
  maxSize = TOOL_CALL_HISTORY_SIZE,
): ToolCallRecord[] {
  const next = [...history, record];
  return next.length > maxSize ? next.slice(-maxSize) : next;
}
