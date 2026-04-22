// packages/skills-general/src/web-fetch.ts
import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';
import { safeFetch } from '@finclaw/infra';

export interface WebFetchConfig {
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export function registerWebFetchTool(registry: ToolRegistry, config: WebFetchConfig): void {
  const def: RegisteredToolDefinition = {
    name: 'web_fetch',
    description:
      '공개 URL의 텍스트 콘텐츠를 가져옵니다. HTML은 태그를 제거하고 텍스트만 추출합니다. 사설/내부 주소는 차단됩니다.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '가져올 URL (http/https)' },
        max_bytes: {
          type: 'number',
          description: '최대 응답 크기 (바이트). 기본 config.maxBytes.',
        },
      },
      required: ['url'],
    },
    group: 'web',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: false,
    isExternal: true,
    timeoutMs: config.timeoutMs + 1_000,
  };

  const executor: ToolExecutor = async (input, ctx) => {
    const urlStr = input.url as string;
    const maxBytes = typeof input.max_bytes === 'number' ? input.max_bytes : config.maxBytes;

    try {
      const parsed = new URL(urlStr);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return {
          content: `Unsupported protocol: ${parsed.protocol}`,
          isError: true,
        };
      }

      const response = await safeFetch(urlStr, {
        timeoutMs: config.timeoutMs,
        allowRedirect: true,
        init: { signal: ctx.abortSignal },
      });

      if (!response.ok) {
        return {
          content: `HTTP ${response.status}: ${response.statusText}`,
          isError: true,
        };
      }

      const contentType = response.headers.get('content-type') ?? 'text/plain';
      const buffer = await readBounded(response, maxBytes);
      const truncated = buffer.truncated;
      let body = buffer.buffer.toString('utf-8');
      if (contentType.includes('html')) {
        body = stripHtml(body);
      }

      return {
        content: truncated ? `${body}\n\n[truncated at ${maxBytes} bytes]` : body,
        isError: false,
        metadata: {
          status: response.status,
          contentType,
          bytes: buffer.buffer.length,
          truncated,
        },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: `web_fetch failed: ${message}`,
        isError: true,
      };
    }
  };

  registry.register(def, executor, 'skill');
}

interface BoundedRead {
  readonly buffer: Buffer;
  readonly truncated: boolean;
}

async function readBounded(response: Response, maxBytes: number): Promise<BoundedRead> {
  const reader = response.body?.getReader();
  if (!reader) {
    return { buffer: Buffer.alloc(0), truncated: false };
  }
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    if (total + value.length > maxBytes) {
      const remaining = maxBytes - total;
      if (remaining > 0) {
        chunks.push(Buffer.from(value.subarray(0, remaining)));
        total += remaining;
      }
      truncated = true;
      await reader.cancel().catch(() => {});
      break;
    }
    chunks.push(Buffer.from(value));
    total += value.length;
  }
  return { buffer: Buffer.concat(chunks), truncated };
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
