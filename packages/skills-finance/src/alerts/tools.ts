import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';
import type { AlertStore } from './types.js';

// ─── list_alerts ───
export function registerListAlertsTool(registry: ToolRegistry, deps: { store: AlertStore }): void {
  const def: RegisteredToolDefinition = {
    name: 'list_alerts',
    description: '현재 사용자의 알림 목록을 조회합니다.',
    inputSchema: { type: 'object', properties: {}, required: [] },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: false,
    timeoutMs: 5_000,
  };
  const executor: ToolExecutor = async (_input, context) => {
    try {
      const alerts = deps.store.listByUser(context.userId);
      return { content: JSON.stringify(alerts), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  registry.register(def, executor, 'skill');
}

// ─── get_alert_history ───
export function registerGetAlertHistoryTool(
  registry: ToolRegistry,
  deps: { store: AlertStore },
): void {
  const def: RegisteredToolDefinition = {
    name: 'get_alert_history',
    description: '알림 트리거 이력을 조회합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        alertId: { type: 'string', description: '알림 ID' },
        limit: { type: 'number', description: '반환할 이력 수 (기본 10)' },
      },
      required: ['alertId'],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: false,
    timeoutMs: 5_000,
  };
  const executor: ToolExecutor = async (input, context) => {
    try {
      const alertId = input.alertId as string;
      const alert = deps.store.getById(alertId);
      if (!alert) {
        return { content: `알림을 찾을 수 없습니다: ${alertId}`, isError: true };
      }
      if (alert.userId !== context.userId) {
        return { content: '다른 사용자의 알림 이력은 조회할 수 없습니다.', isError: true };
      }
      const limit = (input.limit as number | undefined) ?? 10;
      const history = deps.store.getHistory(alertId, limit);
      return { content: JSON.stringify(history), isError: false };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  registry.register(def, executor, 'skill');
}
