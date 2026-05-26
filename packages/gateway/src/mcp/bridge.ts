// packages/gateway/src/mcp/bridge.ts
import type { ToolGroupId, ToolRegistry } from '@finclaw/agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';

/**
 * Phase 40 B: read-only 우선 강제 deny (매수/변경 권한은 사람만 — 사용자 결정 2026-05-26).
 * OpenClaw DEFAULT_GATEWAY_HTTP_TOOL_DENY 패턴: allowlist 와 무관하게 적용되는 최후 방어선.
 * config.mcp.allowTools 로 명시 opt-in 해야만 해제됨.
 * - read_local_file / web_fetch: 임의 FS 읽기 · SSRF (escape hatch, bypassPermissions 라 무프롬프트).
 * - set_alert / remove_alert / schedule_manage / brokerage_sync_holdings: 상태 변경 (DB/cron/외부동기화).
 */
export const DEFAULT_MCP_TOOL_DENY: readonly string[] = [
  'read_local_file',
  'web_fetch',
  'set_alert',
  'remove_alert',
  'schedule_manage',
  'brokerage_sync_holdings',
];

export interface McpBridgeConfig {
  /** 노출 허용 도구 그룹. 미지정 시 전체 그룹 (강제 deny 제외). */
  readonly allowedGroups?: readonly ToolGroupId[];
  /** allowlist 무관 추가 차단 도구명. */
  readonly denyTools?: readonly string[];
  /** DEFAULT_MCP_TOOL_DENY 에서 명시 해제(opt-in)할 도구명. */
  readonly allowTools?: readonly string[];
}

/** 실효 deny 집합 = (DEFAULT_MCP_TOOL_DENY − allowTools) ∪ denyTools. */
export function computeDeniedTools(config: McpBridgeConfig): Set<string> {
  const allow = new Set(config.allowTools ?? []);
  const denied = new Set(DEFAULT_MCP_TOOL_DENY.filter((name) => !allow.has(name)));
  for (const name of config.denyTools ?? []) {
    denied.add(name);
  }
  return denied;
}

/**
 * Phase 40 B: 라이브 ToolRegistry 의 도구를 group allowlist + 강제 deny 로 필터해 MCP 에 일괄 등록.
 * 각 도구 executor 는 toolRegistry.execute (9-stage 정책/가드/감사 통과) 를 호출하고,
 * abortSignal 은 MCP 요청별 extra.signal 을 그대로 전파한다.
 */
export function registerBridgedTools(
  server: McpServer,
  toolRegistry: ToolRegistry,
  config: McpBridgeConfig,
  identity: { readonly userId: string; readonly sessionId: string },
): void {
  const denied = computeDeniedTools(config);
  const allowedGroups = config.allowedGroups ? new Set(config.allowedGroups) : undefined;

  for (const tool of toolRegistry.list()) {
    const def = tool.definition;
    if (denied.has(def.name)) {
      continue; // 강제 deny — allowlist 무관.
    }
    if (allowedGroups && !allowedGroups.has(def.group)) {
      continue; // group allowlist 미통과.
    }
    const shape = jsonSchemaToZodShape(def.inputSchema);
    server.registerTool(
      def.name,
      { description: def.description, inputSchema: shape },
      async (input: Record<string, unknown>, extra: { signal: AbortSignal }) => {
        const result = await toolRegistry.execute(def.name, input, {
          sessionId: identity.sessionId,
          userId: identity.userId,
          channelId: 'mcp',
          abortSignal: extra.signal,
        });
        return {
          content: [{ type: 'text' as const, text: result.content }],
          isError: result.isError,
        };
      },
    );
  }
}

/**
 * RegisteredToolDefinition.inputSchema (JSON Schema 서브셋) → Zod raw shape.
 * registry 의 private jsonSchemaToZod 미러 (registry.ts:143).
 */
export function jsonSchemaToZodShape(inputSchema: unknown): Record<string, z.ZodType> {
  const schema = inputSchema as {
    properties?: Record<string, Record<string, unknown>>;
    required?: readonly string[];
  };
  if (!schema.properties) {
    return {};
  }
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(schema.properties).map(([k, v]) => {
      const base = jsonSchemaToZodType(v);
      return [k, required.has(k) ? base : base.optional()];
    }),
  );
}

function jsonSchemaToZodType(prop: Record<string, unknown>): z.ZodType {
  switch (prop.type) {
    case 'string':
      return prop.enum ? z.enum(prop.enum as [string, ...string[]]) : z.string();
    case 'number':
      return z.number();
    case 'boolean':
      return z.boolean();
    case 'array':
      return z.array(
        prop.items ? jsonSchemaToZodType(prop.items as Record<string, unknown>) : z.unknown(),
      );
    case 'object':
      return z.record(z.string(), z.unknown());
    default:
      return z.unknown();
  }
}
