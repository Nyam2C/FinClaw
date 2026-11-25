import { getEventBus } from '@finclaw/infra';
// packages/server/src/gateway/rpc/index.ts
import type { RpcRequest, RpcResponse } from '@finclaw/types';
import type { GatewayServerContext } from '../context.js';
import { RpcErrors, createError } from './errors.js';
import type {
  JsonRpcBatchRequest,
  RpcMethodHandler,
  RpcContext,
  AuthInfo,
  AuthLevel,
} from './types.js';

/**
 * Phase 35: RPC 메서드 레지스트리. 모듈 전역 Map 을 대체하여 서버 인스턴스별 격리.
 * GatewayServerContext.methods 가 소유. 테스트는 인스턴스를 새로 만들어 격리(전역 reset 우회 불요).
 */
export class MethodRegistry {
  private readonly methods = new Map<string, RpcMethodHandler>();

  register(handler: RpcMethodHandler): void {
    if (this.methods.has(handler.method)) {
      throw new Error(`RPC method already registered: ${handler.method}`);
    }
    this.methods.set(handler.method, handler);
  }

  get(method: string): RpcMethodHandler | undefined {
    return this.methods.get(method);
  }

  /** 등록된 메서드 목록 (system.info 용) */
  list(): string[] {
    return [...this.methods.keys()];
  }
}

/** RPC 요청 디스패치 (단일 또는 배치) */
export async function dispatchRpc(
  request: RpcRequest | JsonRpcBatchRequest,
  ctx: Omit<RpcContext, 'requestId'>,
  serverCtx: GatewayServerContext,
): Promise<RpcResponse | RpcResponse[]> {
  // 배치 요청
  if (Array.isArray(request)) {
    if (request.length === 0) {
      return createError(null, RpcErrors.INVALID_REQUEST, 'Empty batch');
    }
    if (request.length > serverCtx.config.rpc.maxBatchSize) {
      return createError(
        null,
        RpcErrors.INVALID_REQUEST,
        `Batch size ${request.length} exceeds limit ${serverCtx.config.rpc.maxBatchSize}`,
      );
    }
    return Promise.all(request.map((req) => handleSingleRequest(req, ctx, serverCtx)));
  }

  return handleSingleRequest(request as RpcRequest, ctx, serverCtx);
}

/** 단일 RPC 요청 처리 */
async function handleSingleRequest(
  request: RpcRequest,
  ctx: Omit<RpcContext, 'requestId'>,
  serverCtx: GatewayServerContext,
): Promise<RpcResponse> {
  // 1. jsonrpc 버전 검증
  if (request.jsonrpc !== '2.0') {
    return createError(request.id, RpcErrors.INVALID_REQUEST, 'Invalid JSON-RPC version');
  }

  // 2. 메서드 조회 (Phase 35: 인스턴스 레지스트리)
  const handler = serverCtx.methods.get(request.method);
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
  const levels: AuthLevel[] = ['none', 'api_key', 'token'];
  return levels.indexOf(auth.level) >= levels.indexOf(required);
}
