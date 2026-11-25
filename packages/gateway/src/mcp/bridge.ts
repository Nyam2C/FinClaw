// packages/gateway/src/mcp/bridge.ts
import { jsonSchemaToZod, type ToolRegistry } from '@finclaw/agent';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { z } from 'zod/v4';

/**
 * Phase 40 B: 라이브 ToolRegistry 의 도구를 MCP 에 일괄 등록.
 * 상태 변경·escape 도구(set_alert·web_fetch 등)는 레지스트리에서 제거됐으므로 남은 도구는 전부
 * read-only — 별도 deny 필터 없음 (매수/변경 권한은 사람만 — 사용자 결정 2026-05-26).
 * 플러그인 MCP 도구(mcp:*)도 그대로 노출된다 (구 deny 목록도 이들을 거르지 않았음).
 * 각 도구 executor 는 toolRegistry.execute (9-stage 정책/가드/감사 통과) 를 호출하고,
 * abortSignal 은 MCP 요청별 extra.signal 을 그대로 전파한다.
 */
export function registerBridgedTools(
  server: McpServer,
  toolRegistry: ToolRegistry,
  identity: { readonly userId: string; readonly sessionId: string },
): void {
  for (const tool of toolRegistry.list()) {
    const def = tool.definition;
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
 * per-property 변환은 registry 의 jsonSchemaToZod (단일 소스) 를 직접 사용 — 사본 금지(drift 방지).
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
      const base = jsonSchemaToZod(v);
      return [k, required.has(k) ? base : base.optional()];
    }),
  );
}
