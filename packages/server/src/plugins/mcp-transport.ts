import type { MCPServerSpec } from '@finclaw/types';
// packages/server/src/plugins/mcp-transport.ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from '@modelcontextprotocol/sdk/client/stdio.js';

export interface MCPClientHandle {
  readonly client: Client;
  readonly spec: MCPServerSpec;
  shutdown(): Promise<void>;
}

/**
 * Phase 29 D4: stdio MCP 서버를 spawn → 연결 → Client 핸들 반환.
 *
 * - transport: stdio 만 (Phase 29 결정 4)
 * - shutdown: client.close() best-effort (transport 도 함께 정리됨)
 */
export async function createMCPClient(spec: MCPServerSpec): Promise<MCPClientHandle> {
  const transport = new StdioClientTransport({
    command: spec.command,
    args: [...spec.args],
    env: spec.env ? { ...getDefaultEnvironment(), ...spec.env } : undefined,
  });
  const client = new Client({ name: 'finclaw', version: '0.1.0' }, { capabilities: {} });
  await client.connect(transport);

  return {
    client,
    spec,
    async shutdown() {
      try {
        await client.close();
      } catch {
        // best-effort
      }
    },
  };
}
