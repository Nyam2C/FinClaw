// packages/server/src/gateway/rpc/methods/system.ts
import { z } from 'zod/v4';
import type { RpcMethodHandler } from '../types.js';
import { registerMethod, getRegisteredMethods } from '../index.js';

// -- system.health --

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

// -- system.info --

const infoHandler: RpcMethodHandler<
  Record<string, never>,
  {
    name: string;
    version: string;
    methods: string[];
    capabilities: string[];
  }
> = {
  method: 'system.info',
  description: '서버 버전 및 기능 정보를 반환합니다',
  authLevel: 'none',
  schema: z.object({}),
  async execute() {
    return {
      name: 'finclaw-gateway',
      version: '0.1.0',
      methods: getRegisteredMethods(),
      capabilities: ['streaming', 'batch', 'subscriptions'],
    };
  },
};

// -- system.ping --

const pingHandler: RpcMethodHandler<Record<string, never>, { pong: true; timestamp: number }> = {
  method: 'system.ping',
  description: 'Ping-pong 연결 확인',
  authLevel: 'none',
  schema: z.object({}),
  async execute() {
    return { pong: true, timestamp: Date.now() };
  },
};

/** system.* 메서드 일괄 등록 */
export function registerSystemMethods(): void {
  registerMethod(healthHandler);
  registerMethod(infoHandler);
  registerMethod(pingHandler);
}
