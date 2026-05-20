// packages/skills-general/src/schedule-tool.ts
// OpenClaw cron-tool.ts (TypeBox 8 action) → FinClaw 3 action (create/list/delete) 단순화.
// Discord 1인 환경에서 wake/runs 같은 운영 action 불요. agent 가 자주 호출할 패턴만 유지.
// FinClaw 의 RegisteredToolDefinition + ToolExecutor 패턴 (datetime/file-read/web-fetch 와 동일).

import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';
import type { ScheduleRpc } from '@finclaw/types';

export function registerScheduleTool(registry: ToolRegistry, rpc: ScheduleRpc): void {
  const def: RegisteredToolDefinition = {
    name: 'schedule_manage',
    description: [
      '사용자의 자동화 schedule 을 등록/조회/삭제한다.',
      '사용자가 "매일 X시에 Y해줘", "매주 월요일에 Z 보내줘" 같이 요청하면 action="create" 호출.',
      'cron 표현은 표준 5-field (분 시 일 월 요일). timezone 은 UTC 기준.',
      '한국 시간 12시 = UTC 03:00 → cron "0 3 * * *".',
    ].join(' '),
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: '수행할 작업: create | list | delete',
          enum: ['create', 'list', 'delete'],
        },
        name: {
          type: 'string',
          description: 'create: schedule 이름 (1-80자).',
        },
        cron: {
          type: 'string',
          description:
            'create: cron 표현식. 예: "0 12 * * *" (매일 12시 UTC), "0 9 * * 1" (매주 월요일 9시 UTC)',
        },
        prompt: {
          type: 'string',
          description:
            'create: schedule 발동 시 agent 에 보낼 명령. 예: "현재 포트폴리오 요약해줘"',
        },
        scheduleId: {
          type: 'string',
          description: 'delete: 삭제할 schedule 의 id.',
        },
      },
      required: ['action'],
    },
    group: 'custom',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: false,
    timeoutMs: 10_000,
  };

  const executor: ToolExecutor = async (input) => {
    const action = input.action;
    if (action === 'create') {
      const name = typeof input.name === 'string' ? input.name : '';
      const cron = typeof input.cron === 'string' ? input.cron : '';
      const prompt = typeof input.prompt === 'string' ? input.prompt : '';
      if (!name || !cron || !prompt) {
        return {
          content: 'create 에는 name, cron, prompt 가 모두 필요합니다.',
          isError: true,
        };
      }
      // cron 사전 검증
      try {
        const validation = await rpc.testCron({ cron });
        if (!validation.valid) {
          return {
            content: `잘못된 cron 표현식: ${validation.reason ?? 'unknown'}`,
            isError: true,
          };
        }
      } catch (e) {
        return {
          content: `잘못된 cron 표현식: ${(e as Error).message}`,
          isError: true,
        };
      }
      const result = await rpc.create({ name, cron, prompt, enabled: true });
      return {
        content: `schedule 등록됨: id=${result.id}, 다음 실행=${result.nextRunAt ?? 'n/a'}`,
        isError: false,
        metadata: { scheduleId: result.id, nextRunAt: result.nextRunAt },
      };
    }
    if (action === 'list') {
      const result = await rpc.list({ limit: 20 });
      const lines = result.schedules.map(
        (s) =>
          `- ${s.name} (id=${s.id}, cron="${s.cron}", enabled=${s.enabled}, status=${s.status}, failures=${s.consecutiveFailures})`,
      );
      return {
        content: lines.length > 0 ? lines.join('\n') : '등록된 schedule 이 없습니다.',
        isError: false,
        metadata: { count: result.schedules.length },
      };
    }
    if (action === 'delete') {
      const scheduleId = typeof input.scheduleId === 'string' ? input.scheduleId : '';
      if (!scheduleId) {
        return { content: 'delete 에는 scheduleId 가 필요합니다.', isError: true };
      }
      await rpc.delete({ scheduleId });
      return { content: `schedule 삭제됨: ${scheduleId}`, isError: false };
    }
    return { content: `알 수 없는 action: ${String(action)}`, isError: true };
  };

  registry.register(def, executor, 'skill');
}
