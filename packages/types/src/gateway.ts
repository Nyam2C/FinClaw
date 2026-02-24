/** RPC 메서드 이름 */
export type RpcMethod =
  | 'agent.run'
  | 'agent.list'
  | 'agent.status'
  | 'session.get'
  | 'session.reset'
  | 'session.list'
  | 'config.get'
  | 'config.update'
  | 'channel.list'
  | 'channel.status'
  | 'health.check'
  | 'skill.execute'
  | 'finance.quote'
  | 'finance.news'
  | 'finance.alert.create'
  | 'finance.alert.list'
  | 'finance.portfolio.get';

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

/** WebSocket 이벤트 */
export type WsEvent =
  | WsMessageEvent
  | WsTypingEvent
  | WsAgentStatusEvent
  | WsAlertEvent
  | WsErrorEvent;

export interface WsMessageEvent {
  type: 'message';
  channelId: string;
  senderId: string;
  text: string;
  timestamp: number;
}

export interface WsTypingEvent {
  type: 'typing';
  channelId: string;
  agentId: string;
  isTyping: boolean;
}

export interface WsAgentStatusEvent {
  type: 'agent.status';
  agentId: string;
  status: 'idle' | 'running' | 'error';
}

export interface WsAlertEvent {
  type: 'alert';
  alertId: string;
  symbol: string;
  condition: string;
  currentValue: number;
  triggeredAt: number;
}

export interface WsErrorEvent {
  type: 'error';
  code: number;
  message: string;
}

/** 게이트웨이 상태 */
export interface GatewayStatus {
  uptime: number;
  connections: number;
  activeAgents: number;
  activeSessions: number;
  version: string;
}
