// packages/server/src/auto-reply/stages/command.ts
import type { MsgContext } from '@finclaw/types';
import type { CommandRegistry, CommandResult } from '../commands/registry.js';

export interface CommandStageResult {
  readonly handled: boolean;
  readonly commandResult?: CommandResult;
}

/**
 * 명령어 단계 — 명령이면 실행 결과를 돌려주고(B4: 예전엔 버렸다) pipeline 이 채널로 보낸다.
 * 코드 펜스 안·미등록·비명령은 handled:false (일반 메시지로 AI 에 전달).
 */
export async function commandStage(
  normalizedBody: string,
  registry: CommandRegistry,
  prefix: string,
  ctx: MsgContext,
): Promise<CommandStageResult> {
  if (isInsideCodeFence(normalizedBody, prefix)) {
    return { handled: false };
  }
  const parsed = registry.parse(normalizedBody, prefix);
  if (!parsed) {
    return { handled: false };
  }
  const command = registry.get(parsed.name);
  if (!command) {
    return { handled: false };
  }
  return { handled: true, commandResult: await command.executor(parsed.args, ctx) };
}

/** 코드 펜스(```) 내부에 있는 명령어인지 판별 */
function isInsideCodeFence(body: string, prefix: string): boolean {
  const prefixIndex = body.indexOf(prefix);
  if (prefixIndex === -1) {
    return false;
  }

  const beforePrefix = body.slice(0, prefixIndex);
  const fenceCount = (beforePrefix.match(/```/g) ?? []).length;
  return fenceCount % 2 === 1;
}
