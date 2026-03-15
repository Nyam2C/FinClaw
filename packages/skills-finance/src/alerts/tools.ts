import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';
import { z } from 'zod/v4';
import type { AlertCondition, AlertStore } from './types.js';

// ─── Zod 스키마 ───
const PriceConditionSchema = z.object({
  type: z.literal('price'),
  ticker: z.string().min(1).max(10),
  direction: z.enum(['above', 'below']),
  threshold: z.number().positive(),
});
const ChangeConditionSchema = z.object({
  type: z.literal('change'),
  ticker: z.string().min(1).max(10),
  thresholdPercent: z.number().positive(),
  direction: z.enum(['up', 'down', 'both']).default('both'),
});
const VolumeConditionSchema = z.object({
  type: z.literal('volume'),
  ticker: z.string().min(1).max(10),
  multiplier: z.number().positive(),
});
const NewsConditionSchema = z.object({
  type: z.literal('news'),
  keywords: z.array(z.string()).min(1),
  symbols: z.array(z.string()).optional(),
  excludeKeywords: z.array(z.string()).optional(),
});
const AlertConditionSchema = z.discriminatedUnion('type', [
  PriceConditionSchema,
  ChangeConditionSchema,
  VolumeConditionSchema,
  NewsConditionSchema,
]);

export function buildConditionFromParams(input: Record<string, unknown>): AlertCondition {
  const result = AlertConditionSchema.safeParse(input.condition);
  if (!result.success) {
    throw new Error(`조건 파라미터 오류: ${result.error.message}`);
  }
  return result.data;
}

// ─── set_alert ───
export function registerSetAlertTool(registry: ToolRegistry, deps: { store: AlertStore }): void {
  const def: RegisteredToolDefinition = {
    name: 'set_alert',
    description: '금융 알림을 설정합니다. 가격, 변동률, 거래량, 뉴스 키워드 조건을 지원합니다.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '알림 이름' },
        condition: { type: 'object', description: '알림 조건 (type: price|change|volume|news)' },
        cooldownMs: { type: 'number', description: '쿨다운 밀리초 (기본 900000)' },
        expiresAt: { type: 'number', description: '만료 시각 (Unix ms, 선택)' },
      },
      required: ['name', 'condition'],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: true,
    accessesSensitiveData: false,
    isExternal: false,
    timeoutMs: 5_000,
  };
  const executor: ToolExecutor = async (input, context) => {
    try {
      const condition = buildConditionFromParams(input);
      const alert = deps.store.create({
        userId: context.userId,
        name: input.name as string,
        condition,
        // TODO(R15): channels가 하드코딩됨 — 향후 inputSchema에 channels 파라미터 추가
        channels: ['discord', 'websocket'],
        cooldownMs: input.cooldownMs as number | undefined,
        enabled: true,
        expiresAt: input.expiresAt as number | undefined,
      });
      return {
        content: JSON.stringify({
          alertId: alert.id,
          name: alert.name,
          condition: alert.condition,
        }),
        isError: false,
      };
    } catch (error) {
      return { content: error instanceof Error ? error.message : String(error), isError: true };
    }
  };
  registry.register(def, executor, 'skill');
}

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

// ─── remove_alert ───
export function registerRemoveAlertTool(registry: ToolRegistry, deps: { store: AlertStore }): void {
  const def: RegisteredToolDefinition = {
    name: 'remove_alert',
    description: '알림을 삭제합니다.',
    inputSchema: {
      type: 'object',
      properties: { alertId: { type: 'string', description: '삭제할 알림 ID' } },
      required: ['alertId'],
    },
    group: 'finance',
    requiresApproval: false,
    isTransactional: true,
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
        return { content: '다른 사용자의 알림은 삭제할 수 없습니다.', isError: true };
      }
      deps.store.delete(alertId);
      return { content: JSON.stringify({ deleted: true, alertId }), isError: false };
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
