// packages/server/src/router/sub-agent.ts
// Phase 46 M3: route_task 서브에이전트 = 드라이버 동기 1-shot. 격리 argv 는 드라이버가 강제(N1),
// MCP 없음·--no-session-persistence. 전역 상한 밖(최상위 run 이 슬롯을 쥔 채 기다리므로 포함하면 교착 — Q7).
import { randomUUID } from 'node:crypto';
import type { AgentDriver } from '@finclaw/agent';

export interface SubAgentRequest {
  readonly systemPrompt: string;
  readonly query: string;
  readonly modelId?: string;
}

export interface SubAgentResponse {
  readonly text: string;
}

const DEFAULT_SUB_AGENT_MODEL = 'claude-opus-4-7';
/** Q13: 서브 무출력 45s / overall 75s < route_task 90s < 메인 무출력 120s. */
const SUB_IDLE_TIMEOUT_MS = 45_000;
const SUB_OVERALL_TIMEOUT_MS = 75_000;

export async function runSubAgent(
  driver: AgentDriver,
  req: SubAgentRequest,
  signal?: AbortSignal,
): Promise<SubAgentResponse> {
  for await (const ev of driver({
    runId: randomUUID(),
    prompt: req.query,
    systemPrompt: req.systemPrompt,
    model: req.modelId ?? DEFAULT_SUB_AGENT_MODEL,
    session: { kind: 'none' },
    idleTimeoutMs: SUB_IDLE_TIMEOUT_MS,
    overallTimeoutMs: SUB_OVERALL_TIMEOUT_MS,
    signal: signal ?? new AbortController().signal,
  })) {
    if (ev.type === 'done') {
      return { text: ev.text };
    }
    if (ev.type === 'error') {
      throw new Error(`sub-agent ${ev.reason}: ${ev.message}`);
    }
  }
  throw new Error('sub-agent ended without result');
}
