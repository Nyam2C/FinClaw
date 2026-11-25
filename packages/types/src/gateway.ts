/** RPC 메서드 이름 */
export type RpcMethod =
  | 'agent.run'
  | 'agent.list'
  | 'agent.status'
  | 'agent.runs.list'
  | 'agent.runs.get'
  | 'schedule.create'
  | 'schedule.list'
  | 'schedule.update'
  | 'schedule.delete'
  | 'schedule.runNow'
  | 'schedule.history'
  | 'schedule.disable'
  | 'schedule.enable'
  | 'session.get'
  | 'finance.quote'
  | 'finance.news'
  | 'finance.alert.create'
  | 'finance.alert.list'
  | 'finance.portfolio.get'
  | 'finance.transaction.add'
  | 'finance.transaction.list'
  | 'finance.transaction.update'
  | 'finance.transaction.delete'
  | 'memory.list'
  | 'memory.delete'
  | 'memory.search'
  | 'chat.start'
  | 'chat.send'
  | 'chat.abort'
  | 'chat.reset'
  | 'system.health'
  | 'system.info'
  | 'system.ping';

/** JSON-RPC 2.0 요청 */
export interface RpcRequest<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  method: RpcMethod;
  params?: T;
}

/** JSON-RPC 2.0 응답 */
export interface RpcResponse<T = unknown> {
  jsonrpc: '2.0';
  id: string | number;
  result?: T;
  error?: RpcError;
}

/** JSON-RPC 2.0 에러 */
export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

/** 표준 RPC 에러 코드 */
export const RPC_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  UNAUTHORIZED: -32001,
  RATE_LIMITED: -32002,
  SESSION_NOT_FOUND: -32003,
  AGENT_BUSY: -32004,
} as const;
