// packages/server/src/plugins/mcp-tool-bridge.ts
import type {
  RegisteredToolDefinition,
  ToolExecutionContext,
  ToolExecutor,
  ToolRegistry,
} from '@finclaw/agent';
import type { MCPClientHandle } from './mcp-transport.js';

export interface MCPToolRegistration {
  readonly definition: RegisteredToolDefinition;
  readonly executor: ToolExecutor;
}

/**
 * Phase 29 D5: MCP server.listTools() → FinClaw RegisteredToolDefinition 변환 + executor.
 *
 * - group='mcp' (Phase 29 결정 5: 일괄 권한 분리)
 * - isExternal=true → CircuitBreaker 적용
 * - requiresApproval=true (require-approval 기본)
 * - inputSchema 는 MCP 의 JSON Schema 그대로 (ToolDefinition.inputSchema 는 Record<string, unknown>)
 * - 도구명 namespace: `mcp:<spec.id>:<original_name>`
 */
export async function bridgeMCPTools(handle: MCPClientHandle): Promise<MCPToolRegistration[]> {
  const tools = await handle.client.listTools();
  const registrations: MCPToolRegistration[] = [];

  for (const t of tools.tools) {
    const namespaced = `mcp:${handle.spec.id}:${t.name}`;
    const definition: RegisteredToolDefinition = {
      name: namespaced,
      description: t.description ?? `MCP tool ${t.name}`,
      inputSchema: (t.inputSchema as Record<string, unknown>) ?? {
        type: 'object',
        properties: {},
      },
      group: 'mcp',
      requiresApproval: true,
      isTransactional: false,
      accessesSensitiveData: false,
      isExternal: true,
      timeoutMs: handle.spec.timeoutMs ?? 30_000,
    };

    const executor: ToolExecutor = async (
      input: Record<string, unknown>,
      ctx: ToolExecutionContext,
    ) => {
      try {
        const result = await handle.client.callTool({ name: t.name, arguments: input }, undefined, {
          timeout: handle.spec.timeoutMs ?? 30_000,
          signal: ctx.abortSignal,
        });
        // MCP CallToolResult.content[] → 단일 string 으로 join.
        const content = ((result.content as Array<{ type: string; text?: string }>) ?? [])
          .map((b) => (b.type === 'text' ? (b.text ?? '') : ''))
          .join('\n');
        return {
          content,
          isError: result.isError === true,
          metadata: { source: 'mcp', server: handle.spec.id, originalName: t.name },
        };
      } catch (err) {
        return {
          content: `MCP tool error: ${(err as Error).message}`,
          isError: true,
          metadata: { source: 'mcp', server: handle.spec.id },
        };
      }
    };

    registrations.push({ definition, executor });
  }
  return registrations;
}

export function registerMCPTools(
  registry: ToolRegistry,
  registrations: readonly MCPToolRegistration[],
): void {
  for (const r of registrations) {
    registry.register(r.definition, r.executor, 'plugin');
  }
}
