// packages/server/src/gateway/rpc/methods/config.ts
import { z } from 'zod/v4';
import type { RpcMethodHandler } from '../types.js';
import { registerMethod } from '../index.js';

// -- config.get --

const getHandler: RpcMethodHandler<{ keys?: string[] }, Record<string, unknown>> = {
  method: 'config.get',
  description: '현재 설정을 조회합니다',
  authLevel: 'token',
  schema: z.object({
    keys: z.array(z.string()).optional(),
  }),
  async execute(params) {
    // TODO(Phase 10): @finclaw/config loadConfig() 연동
    // 민감 정보 (apiKeys, jwtSecret) 마스킹 필요
    return { keys: params.keys ?? [], message: 'config.get stub' };
  },
};

// -- config.set --

const setHandler: RpcMethodHandler<{ key: string; value: unknown }, { updated: boolean }> = {
  method: 'config.update',
  description: '설정 값을 변경합니다',
  authLevel: 'token',
  schema: z.object({
    key: z.string(),
    value: z.unknown(),
  }),
  async execute(_params) {
    // TODO(Phase 10): @finclaw/config setOverride() 연동
    return { updated: true };
  },
};

// -- config.reload --

const reloadHandler: RpcMethodHandler<Record<string, never>, { reloaded: boolean }> = {
  method: 'config.reload',
  description: '설정 파일을 다시 읽어옵니다',
  authLevel: 'token',
  schema: z.object({}),
  async execute() {
    // TODO(Phase 10): @finclaw/config clearConfigCache() + loadConfig() 연동
    return { reloaded: true };
  },
};

/** config.* 메서드 일괄 등록 */
export function registerConfigMethods(): void {
  registerMethod(getHandler);
  registerMethod(setHandler);
  registerMethod(reloadHandler);
}
