// packages/server/src/gateway/rpc/methods/finance.ts
import { z } from 'zod/v4';
import type { RpcMethodHandler } from '../types.js';
import { registerMethod } from '../index.js';

// -- finance.quote --

const quoteHandler: RpcMethodHandler<{ symbol: string }, unknown> = {
  method: 'finance.quote',
  description: '종목 시세를 조회합니다',
  authLevel: 'token',
  schema: z.object({ symbol: z.string() }),
  async execute(_params) {
    // TODO(Phase 10): @finclaw/skills-finance 연동
    throw new Error('Not implemented: finance.quote');
  },
};

// -- finance.news --

const newsHandler: RpcMethodHandler<{ query?: string; symbols?: string[] }, unknown> = {
  method: 'finance.news',
  description: '금융 뉴스를 검색합니다',
  authLevel: 'token',
  schema: z.object({
    query: z.string().optional(),
    symbols: z.array(z.string()).optional(),
  }),
  async execute(_params) {
    throw new Error('Not implemented: finance.news');
  },
};

// -- finance.alert.create --

const alertCreateHandler: RpcMethodHandler<
  { symbol: string; condition: string; threshold: number },
  unknown
> = {
  method: 'finance.alert.create',
  description: '가격 알림을 생성합니다',
  authLevel: 'token',
  schema: z.object({
    symbol: z.string(),
    condition: z.string(),
    threshold: z.number(),
  }),
  async execute(_params) {
    throw new Error('Not implemented: finance.alert.create');
  },
};

// -- finance.alert.list --

const alertListHandler: RpcMethodHandler<{ symbol?: string }, unknown> = {
  method: 'finance.alert.list',
  description: '설정된 알림 목록을 조회합니다',
  authLevel: 'token',
  schema: z.object({
    symbol: z.string().optional(),
  }),
  async execute(_params) {
    throw new Error('Not implemented: finance.alert.list');
  },
};

// -- finance.portfolio.get --

const portfolioGetHandler: RpcMethodHandler<Record<string, never>, unknown> = {
  method: 'finance.portfolio.get',
  description: '포트폴리오를 조회합니다',
  authLevel: 'token',
  schema: z.object({}),
  async execute() {
    throw new Error('Not implemented: finance.portfolio.get');
  },
};

/** finance.* 메서드 일괄 등록 */
export function registerFinanceMethods(): void {
  registerMethod(quoteHandler);
  registerMethod(newsHandler);
  registerMethod(alertCreateHandler);
  registerMethod(alertListHandler);
  registerMethod(portfolioGetHandler);
}
