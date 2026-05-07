// Phase 29 D11: 인라인 stdio MCP 서버 — `echo` 도구 1개를 노출.
// 테스트가 spawn 한다.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo', version: '0.0.1' });

server.registerTool(
  'echo',
  {
    description: 'echoes input',
    inputSchema: { text: z.string() },
  },
  async ({ text }) => ({
    content: [{ type: 'text', text: String(text ?? '') }],
  }),
);

await server.connect(new StdioServerTransport());
