// packages/server/src/composition/constants.ts
// Phase 36: main.ts 에서 추출한 공유 상수. Phase 46 M10: host·secret 은 부팅 시 main 이 해석(GATEWAY_HOST / local-auth).

import type { GatewayServerConfig } from '@finclaw/gateway';
import type { ModelRef } from '@finclaw/types';

/** 기본 게이트웨이 설정 — jwtSecret 은 타입으로 빠져 있어 main 이 반드시 채운다. */
export const defaultConfig: Omit<GatewayServerConfig, 'auth'> & {
  readonly auth: Omit<GatewayServerConfig['auth'], 'jwtSecret'>;
} = {
  host: '127.0.0.1', // B6: 0.0.0.0 → loopback. Docker 는 GATEWAY_HOST=0.0.0.0 (R8)
  port: 3000,
  cors: {
    // D7: vite dev/preview 포트. WS 는 vite proxy 경유라 CORS 무관.
    origins: ['http://localhost:5173', 'http://127.0.0.1:5173'],
    maxAge: 600,
  },
  auth: {
    apiKeys: [],
    sessionTtlMs: 30 * 60_000,
  },
  ws: {
    heartbeatIntervalMs: 30_000,
    heartbeatTimeoutMs: 10_000,
    maxPayloadBytes: 1024 * 1024,
    handshakeTimeoutMs: 10_000,
    maxConnections: 100,
  },
  rpc: {
    maxBatchSize: 10,
    timeoutMs: 60_000,
  },
};

export const DEFAULT_MODEL: ModelRef = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
};
