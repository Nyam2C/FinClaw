// packages/infra/src/context.ts
import { AsyncLocalStorage } from 'node:async_hooks';

/** 요청별 컨텍스트 */
export interface RequestContext {
  requestId: string;
  sessionKey?: string;
  startedAt: number;
}

const als = new AsyncLocalStorage<RequestContext>();

/** 컨텍스트를 주입하고 콜백 실행 */
export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return als.run(ctx, fn);
}

/** 현재 컨텍스트 조회 (없으면 undefined) */
export function getContext(): RequestContext | undefined {
  return als.getStore();
}
