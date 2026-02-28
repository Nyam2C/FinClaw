// packages/server/src/auto-reply/stages/command.ts
import type { MsgContext } from '@finclaw/types';
import type { CommandRegistry, CommandResult } from '../commands/registry.js';
import type { StageResult } from '../pipeline.js';

export interface CommandStageResult {
  readonly handled: boolean;
  readonly commandResult?: CommandResult;
}

/**
 * 명령어 단계
 *
 * 1. 메시지가 명령어 접두사로 시작하는지 확인
 * 2. 코드 펜스 내부의 명령어는 무시 (isInsideCodeFence)
 * 3. CommandRegistry에서 명령어 조회
 * 4. 매칭되면: 명령어 실행 -> skip (AI 호출 불필요)
 * 5. 미매칭이면: continue (일반 메시지로 AI에 전달)
 */
export async function commandStage(
  normalizedBody: string,
  registry: CommandRegistry,
  prefix: string,
  ctx: MsgContext,
): Promise<StageResult<MsgContext>> {
  // 코드 펜스 내부의 명령어는 무시
  if (isInsideCodeFence(normalizedBody, prefix)) {
    return { action: 'continue', data: ctx };
  }

  const parsed = registry.parse(normalizedBody, prefix);
  if (!parsed) {
    return { action: 'continue', data: ctx };
  }

  const command = registry.get(parsed.name);
  if (!command) {
    return { action: 'continue', data: ctx };
  }

  // TODO: 권한 시스템 구현 시 사용자 역할(ctx.userRoles)과 command.definition.requiredRoles를 비교하도록 변경.
  // 현재는 requiredRoles가 설정된 명령어는 항상 거부됨 (Phase 8 placeholder).
  if (command.definition.requiredRoles?.length) {
    return { action: 'skip', reason: `Insufficient permissions for command: ${parsed.name}` };
  }

  // 명령어 실행
  await command.executor(parsed.args, ctx);

  return { action: 'skip', reason: `Command executed: ${parsed.name}` };
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
