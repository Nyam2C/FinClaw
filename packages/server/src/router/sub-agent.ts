import { runCliAgent } from '@finclaw/agent';

/**
 * sub-agent 1회 호출 유틸.
 * 메인 ReAct 가 보유한 풀 컨텍스트 (시스템 프롬프트·도구 4 스킬·메시지 히스토리) 를
 * 상속하지 않고, 좁은 system prompt + 좁은 도구 세트의 별도 claude CLI 프로세스를 spawn.
 *
 * - cliSessionId 미전달 = stateless 1-shot (세션 비공유).
 * - 기본 queueKey 'claude-sub-agent' — outer ReAct 와 다른 큐로 중첩 spawn 데드락 회피.
 */
export interface SubAgentRequest {
  readonly systemPrompt: string;
  readonly query: string;
  readonly modelId?: string;
  readonly timeoutMs?: number;
  readonly queueKey?: string;
}

export interface SubAgentResponse {
  readonly text: string;
  readonly usage?: { readonly input: number; readonly output: number };
}

const DEFAULT_SUB_AGENT_MODEL = 'claude-opus-4-7';
const DEFAULT_SUB_AGENT_QUEUE = 'claude-sub-agent';

export async function runSubAgent(req: SubAgentRequest): Promise<SubAgentResponse> {
  const res = await runCliAgent({
    systemPrompt: req.systemPrompt,
    prompt: req.query,
    modelId: req.modelId ?? DEFAULT_SUB_AGENT_MODEL,
    timeoutMs: req.timeoutMs ?? 60_000,
    queueKey: req.queueKey ?? DEFAULT_SUB_AGENT_QUEUE,
  });
  return {
    text: res.text,
    usage: res.usage
      ? { input: res.usage.input ?? 0, output: res.usage.output ?? 0 }
      : undefined,
  };
}
