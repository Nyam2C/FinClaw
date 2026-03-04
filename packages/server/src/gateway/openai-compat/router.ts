// packages/server/src/gateway/openai-compat/router.ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { GatewayServerContext } from '../context.js';
import type { OpenAIChatRequest, OpenAIErrorResponse } from '../rpc/types.js';
import { readBody } from '../router.js';
import { adaptRequest, mapModelId } from './adapter.js';

/**
 * POST /v1/chat/completions
 * Feature flag: config.openaiCompat?.enabled === true
 */
export async function handleChatCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: GatewayServerContext,
): Promise<void> {
  let body: string;
  try {
    body = await readBody(req);
  } catch {
    sendError(res, 400, 'invalid_request_error', 'Failed to read request body');
    return;
  }

  let openaiRequest: OpenAIChatRequest;
  try {
    openaiRequest = JSON.parse(body);
  } catch {
    sendError(res, 400, 'invalid_request_error', 'Invalid JSON');
    return;
  }

  const internalModel = mapModelId(openaiRequest.model);
  if (!internalModel) {
    sendError(res, 400, 'invalid_request_error', `Unknown model: ${openaiRequest.model}`, 'model');
    return;
  }

  const _internalRequest = adaptRequest(openaiRequest, internalModel);
  const abort = new AbortController();
  req.on('close', () => abort.abort());

  if (openaiRequest.stream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const keepaliveMs = ctx.config.openaiCompat?.sseKeepaliveMs ?? 15_000;
    const keepalive = setInterval(() => {
      if (!res.destroyed) {
        res.write(':keepalive\n\n');
      }
    }, keepaliveMs);

    try {
      // TODO(Phase 12+): runner.execute(internalRequest, listener, abort.signal)
      res.write('data: [DONE]\n\n');
    } finally {
      clearInterval(keepalive);
      res.end();
    }
  } else {
    // TODO(Phase 12+): 동기 실행 엔진 연동
    res.writeHead(501, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: { message: 'Not implemented', type: 'server_error', code: null, param: null },
      } satisfies OpenAIErrorResponse),
    );
  }
}

function sendError(
  res: ServerResponse,
  status: number,
  type: OpenAIErrorResponse['error']['type'],
  message: string,
  param: string | null = null,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      error: { message, type, code: null, param },
    } satisfies OpenAIErrorResponse),
  );
}
