import type { RpcResponse } from '@finclaw/types';
// packages/server/src/gateway/rpc/errors.ts
import { RPC_ERROR_CODES } from '@finclaw/types';

/**
 * 게이트웨이 에러 코드
 *
 * @finclaw/types 기준 (불변):
 *   PARSE_ERROR:       -32700
 *   INVALID_REQUEST:   -32600
 *   METHOD_NOT_FOUND:  -32601
 *   INVALID_PARAMS:    -32602
 *   INTERNAL_ERROR:    -32603
 *   UNAUTHORIZED:      -32001
 *   RATE_LIMITED:      -32002
 *   SESSION_NOT_FOUND: -32003
 *   AGENT_BUSY:        -32004
 *
 * 게이트웨이 전용 확장 (범위: -32005 ~ -32099):
 */
export const RpcErrors = {
  ...RPC_ERROR_CODES,
  AGENT_NOT_FOUND: -32005,
  EXECUTION_ERROR: -32006,
  CONTEXT_OVERFLOW: -32007,
} as const;

export type RpcErrorCode = (typeof RpcErrors)[keyof typeof RpcErrors];

/** JSON-RPC 에러 응답 생성 */
export function createError(
  id: string | number | null,
  code: RpcErrorCode,
  message: string,
  data?: unknown,
): RpcResponse {
  return {
    jsonrpc: '2.0',
    id: id ?? (null as unknown as string),
    error: { code, message, ...(data !== undefined && { data }) },
  };
}
