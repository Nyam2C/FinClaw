// packages/server/src/gateway/rpc/index.ts
import type { RpcRequest, RpcResponse } from '@finclaw/types';
import { getEventBus } from '@finclaw/infra';
import type { GatewayServerContext } from '../context.js';
import type {
  JsonRpcBatchRequest,
  RpcMethodHandler,
  RpcContext,
  AuthInfo,
  AuthLevel,
} from './types.js';
import { RpcErrors, createError } from './errors.js';

const methods = new Map<string, RpcMethodHandler>();

/** 메서드 등록 */
export function registerMethod(handler: RpcMethodHandler): void {
  if (methods.has(handler.method)) {
    throw new Error(`RPC method already registered: ${handler.method}`);
  }
  methods.set(handler.method, handler);
}

/** 등록된 메서드 목록 (system.info 용) */
export function getRegisteredMethods(): string[] {
  return [...methods.keys()];
}

/** 테스트용: 모든 메서드 등록 해제 */
export function clearMethods(): void {
  methods.clear();
}

/** RPC 요청 디스패치 (단일 또는 배치) */
export async function dispatchRpc(
  request: RpcRequest | JsonRpcBatchRequest,
  ctx: Omit<RpcContext, 'requestId'>,
  _serverCtx: GatewayServerContext,
): Promise<RpcResponse | RpcResponse[]> {
  // 배치 요청
  if (Array.isArray(request)) {
    if (request.length === 0) {
      return createError(null, RpcErrors.INVALID_REQUEST, 'Empty batch');
    }
    if (request.length > _serverCtx.config.rpc.maxBatchSize) {
      return createError(
        null,
        RpcErrors.INVALID_REQUEST,
        `Batch size ${request.length} exceeds limit ${_serverCtx.config.rpc.maxBatchSize}`,
      );
    }
    return Promise.all(request.map((req) => handleSingleRequest(req, ctx, _serverCtx)));
  }

  return handleSingleRequest(request, ctx, _serverCtx);
}

/** 단일 RPC 요청 처리 */
async function handleSingleRequest(
  request: RpcRequest,
  ctx: Omit<RpcContext, 'requestId'>,
  _serverCtx: GatewayServerContext,
): Promise<RpcResponse> {
  // 1. jsonrpc 버전 검증
  if (request.jsonrpc !== '2.0') {
    return createError(request.id, RpcErrors.INVALID_REQUEST, 'Invalid JSON-RPC version');
  }

  // 2. 메서드 조회
  const handler = methods.get(request.method);
  if (!handler) {
    return createError(request.id, RpcErrors.METHOD_NOT_FOUND, `Unknown method: ${request.method}`);
  }

  // 3. 이벤트 발행
  getEventBus().emit('gateway:rpc:request', request.method, ctx.connectionId ?? 'http');

  // 4. 인증 레벨 확인
  if (!hasRequiredAuth(ctx.auth, handler.authLevel)) {
    getEventBus().emit('gateway:rpc:error', request.method, RpcErrors.UNAUTHORIZED);
    return createError(request.id, RpcErrors.UNAUTHORIZED, 'Insufficient permissions');
  }

  // 5. 파라미터 스키마 검증 (Zod v4)
  const parseResult = handler.schema.safeParse(request.params ?? {});
  if (!parseResult.success) {
    getEventBus().emit('gateway:rpc:error', request.method, RpcErrors.INVALID_PARAMS);
    return createError(
      request.id,
      RpcErrors.INVALID_PARAMS,
      `Invalid params: ${parseResult.error?.message}`,
    );
  }

  // 6. 핸들러 실행
  try {
    const rpcCtx: RpcContext = { ...ctx, requestId: request.id };
    const result = await handler.execute(parseResult.data, rpcCtx);
    return { jsonrpc: '2.0', id: request.id, result };
  } catch (error) {
    getEventBus().emit('gateway:rpc:error', request.method, RpcErrors.INTERNAL_ERROR);
    return createError(request.id, RpcErrors.INTERNAL_ERROR, (error as Error).message);
  }
}

/** 필요한 인증 레벨 충족 여부 */
export function hasRequiredAuth(auth: AuthInfo, required: AuthLevel): boolean {
  const levels: AuthLevel[] = ['none', 'api_key', 'token', 'session'];
  return levels.indexOf(auth.level) >= levels.indexOf(required);
}
