// packages/agent/src/providers/claude-cli/runner.ts

import { DEFAULT_CLAUDE_BACKEND, normalizeClaudeModel } from './backends.js';
import { CliFailoverError, classifyCliError } from './errors.js';
import { parseCliJson, type CliOutput } from './parsers.js';
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
  /** Phase 41: 큐 키 override. route_task sub-agent spawn 이 outer CLI 턴과 다른 큐를 쓰게 해
   *  중첩 spawn 데드락 회피. 미지정 시 buildCliQueueKey(backendId:'claude', ...) 기본. */
  queueKey?: string;
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
  // Phase 40 C: in-process HTTP MCP 배선 (backend.mcp 설정 시). 격리: --tools "" 가 내장
  // 도구(Bash/Edit/Read) 전체 차단, --strict-mcp-config 가 사용자 전역 MCP 배제, --allowedTools
  // 가 FinClaw 도구만 자동 승인. 권한 우회는 base args 의 --dangerously-skip-permissions 가 담당.
  if (backend.mcp) {
    const mcpConfig = {
      mcpServers: {
        finclaw: {
          type: 'http',
          url: backend.mcp.url,
          headers: { Authorization: `Bearer ${backend.mcp.mintToken()}` },
        },
      },
    };
    args.push('--mcp-config', JSON.stringify(mcpConfig));
    args.push('--strict-mcp-config');
    args.push('--tools', '');
    args.push('--allowedTools', backend.mcp.allowedTools ?? 'mcp__finclaw__*');
  }

  args.push(req.prompt);

  // env (clearEnv 적용)
  const env: NodeJS.ProcessEnv = { ...process.env, ...backend.env };
  for (const key of backend.clearEnv ?? []) {
    delete env[key];
  }

  // watchdog
  const timeoutMs = req.timeoutMs ?? 60_000;
  const noOutputTimeoutMs = resolveCliNoOutputTimeoutMs({ backend, timeoutMs, useResume });

  // queue — Phase 41: req.queueKey override 우선, 미지정 시 기존 backendId/세션 기반 키.
  const queueKey =
    req.queueKey ??
    buildCliQueueKey({
      backendId: 'claude',
      cliSessionId: useResume ? req.cliSessionId : undefined,
    });

  const result = await enqueueCliRun(queueKey, async () => {
    return spawnWithWatchdog({
      argv: [backend.command, ...args] as [string, ...string[]],
      cwd: req.cwd,
      env,
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

  // 출력 파싱 (--output-format json)
  const parsed: CliOutput = parseCliJson(result.stdout, backend) ?? { text: result.stdout.trim() };

  return {
    text: parsed.text,
    sessionId: parsed.sessionId,
    usage: parsed.usage,
    durationMs: Date.now() - startedAt,
  };
}
