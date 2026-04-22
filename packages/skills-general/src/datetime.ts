// packages/skills-general/src/datetime.ts
import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';

export function registerDatetimeTool(registry: ToolRegistry): void {
  const def: RegisteredToolDefinition = {
    name: 'get_current_datetime',
    description: '현재 날짜와 시간을 ISO 8601 및 지정된 타임존 기준의 로컬 형식으로 반환합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA 타임존 이름. 기본: Asia/Seoul',
        },
      },
    },
    group: 'custom',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: false,
    timeoutMs: 1_000,
  };

  const executor: ToolExecutor = async (input) => {
    const tz =
      typeof input.timezone === 'string' && input.timezone.length > 0
        ? input.timezone
        : 'Asia/Seoul';
    const now = new Date();
    try {
      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      });
      const localized = formatter.format(now);
      return {
        content: `현재: ${localized} (${tz}) · ISO: ${now.toISOString()}`,
        isError: false,
        metadata: { iso: now.toISOString(), localized, timezone: tz },
      };
    } catch {
      return {
        content: `Invalid timezone: ${tz}`,
        isError: true,
      };
    }
  };

  registry.register(def, executor, 'skill');
}
