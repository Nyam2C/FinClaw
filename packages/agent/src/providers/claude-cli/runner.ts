// packages/agent/src/providers/claude-cli/runner.ts

import { DEFAULT_CLAUDE_BACKEND, normalizeClaudeModel } from './backends.js';
import { CliFailoverError, classifyCliError } from './errors.js';
import { parseCliJson, parseCliJsonl, type CliOutput } from './parsers.js';
import { buildCliQueueKey, enqueueCliRun } from './queue.js';
import { resolveCliNoOutputTimeoutMs } from './reliability.js';
import { spawnWithWatchdog } from './spawn.js';
import type { CliBackendConfig } from './types.js';

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
  if (backend.modelArg) {
    args.push(backend.modelArg, normalizedModel);
  }
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
        {
          reason: 'timeout',
          provider,
          model: modelId,
          status: 408,
        },
      );
    }
    if (result.reason === 'overall-timeout') {
      throw new CliFailoverError(
        `CLI exceeded overall timeout (${Math.round(timeoutMs / 1000)}s).`,
        {
          reason: 'timeout',
          provider,
          model: modelId,
          status: 408,
        },
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
