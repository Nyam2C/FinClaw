// packages/gateway/src/mcp/host.ts
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { ToolRegistry } from '@finclaw/agent';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod/v4';
import { authenticate } from '../auth/index.js';
import type { GatewayServerConfig } from '../rpc/types.js';

/**
 * Phase 40 A: in-process HTTP MCP 호스트.
 *
 * StreamableHTTP 는 stateful 프로토콜 — initialize → tools/list → tools/call 가 별도 HTTP
 * 요청으로 오므로 mcp-session-id 로 같은 transport/server 를 재사용해야 한다. (요청마다 새
 * 서버를 만드는 stateless 패턴은 tools/list 에서 -32601 로 실패.) 세션 맵은 McpHost 인스턴스에
 * 캡슐화 (모듈 전역 X — gateway DI 규율 유지). A 에서는 get_stock_price 1개만 노출 (제너릭 브리지는 B).
 */
export interface McpHost {
  handleRequest(
    req: IncomingMessage,
    res: ServerResponse,
    authConfig: GatewayServerConfig['auth'],
  ): Promise<void>;
}

export function createMcpHost(toolRegistry: ToolRegistry): McpHost {
  const transports = new Map<string, StreamableHTTPServerTransport>();

  return {
    async handleRequest(req, res, authConfig): Promise<void> {
      // ① Bearer 인증 (매 요청 — claude 클라이언트가 Authorization 헤더를 항상 첨부).
      const authResult = await authenticate(req, authConfig);
      if (!authResult.ok || authResult.info.level === 'none') {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }

      // ② body 파싱 (initialize 판별 + transport 에 전달 — node:http 는 자동 파싱 안 함).
      let parsedBody: unknown;
      try {
        const raw = await readBody(req);
        parsedBody = raw ? JSON.parse(raw) : undefined;
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid JSON' }));
        return;
      }

      // ③ 세션 라우팅: 기존 세션이면 transport 재사용, 신규 initialize 면 transport 생성.
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      let transport = sessionId ? transports.get(sessionId) : undefined;

      if (!transport) {
        if (sessionId || !isInitializeRequest(parsedBody)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'No valid session for non-initialize request' }));
          return;
        }
        // 신규 세션 — stateful transport (session id 발급) + tool 등록된 McpServer.
        // 명시 타입 — onsessioninitialized 클로저가 created 를 self-reference 하므로 (tsc TS7022).
        const created: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (sid) => {
            transports.set(sid, created);
          },
        });
        // MCP Transport 는 EventTarget 이 아니라 onclose 콜백 프로퍼티만 노출 (SDK API) — addEventListener 불가.
        // oxlint-disable-next-line unicorn/prefer-add-event-listener
        created.onclose = () => {
          if (created.sessionId) {
            transports.delete(created.sessionId);
          }
        };
        const server = new McpServer({ name: 'finclaw', version: '0.1.0' });
        registerSingleTool(
          server,
          toolRegistry,
          'get_stock_price',
          authResult.info.userId ?? 'mcp-user',
        );
        await server.connect(created);
        transport = created;
      }

      await transport.handleRequest(req, res, parsedBody);
    },
  };
}

/** 요청 body 를 문자열로 읽음 (router.ts ↔ host.ts 순환 import 회피용 인라인 reader). */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** 단일 도구를 toolRegistry.execute 경유로 MCP 에 노출 (A 스파이크용). */
export function registerSingleTool(
  server: McpServer,
  toolRegistry: ToolRegistry,
  toolName: string,
  userId: string,
): void {
  const reg = toolRegistry.get(toolName);
  if (!reg) {
    return; // 도구 미등록 시 노출 스킵 (mock 테스트에서는 항상 등록).
  }
  const shape = jsonSchemaToZodShape(reg.definition.inputSchema);
  server.registerTool(
    toolName,
    { description: reg.definition.description, inputSchema: shape },
    async (input: Record<string, unknown>) => {
      const result = await toolRegistry.execute(toolName, input, {
        sessionId: 'mcp',
        userId,
        channelId: 'mcp',
        abortSignal: new AbortController().signal,
      });
      return {
        content: [{ type: 'text' as const, text: result.content }],
        isError: result.isError,
      };
    },
  );
}

/**
 * RegisteredToolDefinition.inputSchema (JSON Schema 서브셋) → Zod raw shape.
 * registry 의 private jsonSchemaToZod 미러 (registry.ts:143). B 에서 bridge.ts 로 이동.
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
