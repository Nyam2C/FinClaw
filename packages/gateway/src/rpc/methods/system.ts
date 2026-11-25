// packages/server/src/gateway/rpc/methods/system.ts
import { z } from 'zod/v4';
import { loadVersion } from '../../version.js';
import type { MethodRegistry } from '../index.js';
import type { RpcMethodHandler } from '../types.js';

// -- system.health -- (모듈 레벨 유지: registry 불요)
const healthHandler: RpcMethodHandler<
  Record<string, never>,
  {
    status: 'ok' | 'degraded' | 'error';
    uptime: number;
    memoryMB: number;
  }
> = {
  method: 'system.health',
  description: '서버 상태를 확인합니다',
  authLevel: 'none',
  schema: z.object({}),
  async execute() {
    return {
      status: 'ok',
      uptime: process.uptime(),
      memoryMB: Math.round(process.memoryUsage.rss() / 1024 / 1024),
    };
  },
};

// -- system.ping -- (모듈 레벨 유지)
const pingHandler: RpcMethodHandler<Record<string, never>, { pong: true; timestamp: number }> = {
  method: 'system.ping',
  description: 'Ping-pong 연결 확인',
  authLevel: 'none',
  schema: z.object({}),
  async execute() {
    return { pong: true, timestamp: Date.now() };
  },
};

/** system.* 메서드 일괄 등록. Phase 35: system.info 가 registry.list() 를 클로저로 캡처. */
export function registerSystemMethods(registry: MethodRegistry): void {
  const infoHandler: RpcMethodHandler<
    Record<string, never>,
    { name: string; version: string; methods: string[]; capabilities: string[] }
  > = {
    method: 'system.info',
    description: '서버 버전 및 기능 정보를 반환합니다',
    authLevel: 'none',
    schema: z.object({}),
    async execute() {
      return {
        name: 'finclaw-gateway',
        version: loadVersion(),
        methods: registry.list(), // Phase 35: 인스턴스 레지스트리 (요청 시점 등록 목록)
        capabilities: ['streaming', 'batch'],
      };
    },
  };
  registry.register(healthHandler);
  registry.register(infoHandler);
  registry.register(pingHandler);
}
