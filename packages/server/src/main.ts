// packages/server/src/main.ts
import { createLogger, getEventBus, assertPortAvailable } from '@finclaw/infra';
import type { GatewayServerConfig } from './gateway/rpc/types.js';
import { createGatewayServer } from './gateway/server.js';
import { ProcessLifecycle } from './process/lifecycle.js';

/** 기본 게이트웨이 설정 */
const defaultConfig: GatewayServerConfig = {
  host: '0.0.0.0',
  port: 3000,
  cors: {
    origins: ['*'],
    maxAge: 600,
  },
  auth: {
    apiKeys: [],
    jwtSecret: process.env.GATEWAY_JWT_SECRET ?? 'dev-secret',
    sessionTtlMs: 30 * 60_000, // 30분
  },
  ws: {
    heartbeatIntervalMs: 30_000,
    heartbeatTimeoutMs: 10_000,
    maxPayloadBytes: 1024 * 1024, // 1MB
    handshakeTimeoutMs: 10_000,
    maxConnections: 100,
  },
  rpc: {
    maxBatchSize: 10,
    timeoutMs: 60_000,
  },
};

async function main(): Promise<void> {
  const logger = createLogger({ name: 'finclaw', level: 'info' });
  const lifecycle = new ProcessLifecycle({ logger });

  // 포트 사용 가능 확인
  await assertPortAvailable(defaultConfig.port);

  // 게이트웨이 서버 생성
  const gateway = createGatewayServer(defaultConfig);

  // CleanupFn 등록
  lifecycle.register(() => gateway.stop());

  // 시그널 핸들러 초기화
  lifecycle.init();

  // 서버 시작
  await gateway.start();
  logger.info(`Gateway server listening on ${defaultConfig.host}:${defaultConfig.port}`);

  // 시스템 준비 이벤트
  getEventBus().emit('system:ready');
}

main().catch((err) => {
  console.error('Failed to start gateway server:', err);
  process.exit(1);
});
