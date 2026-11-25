// packages/config/src/zod-schema.ts
import { z } from 'zod/v4';

/** 게이트웨이 설정 스키마 — auth.token 만 소비 (cli/commands/tui.ts). */
const GatewaySchema = z.strictObject({
  auth: z.strictObject({ token: z.string().optional() }).optional(),
});

/** Phase 37 B: access-log retention 스키마 (types AccessLogConfig 미러). */
const AccessLogSchema = z.strictObject({
  retentionDays: z.number().int().optional(),
});

/** Phase 37 B: RAG re-ranking 토글 스키마 (types RagConfig 미러). */
const RagSchema = z.strictObject({
  rerank: z
    .strictObject({
      enabled: z.boolean().optional(),
      topKFirst: z.number().int().optional(),
    })
    .optional(),
});

/**
 * FinClawConfig 루트 스키마
 *
 * - z.strictObject() 사용: 알 수 없는 키 감지 (오타 방지)
 * - 모든 최상위 섹션은 optional (빈 {} 허용)
 * - 런타임이 실제로 읽는 키만 둔다
 */
export const FinClawConfigSchema = z.strictObject({
  gateway: GatewaySchema.optional(),
  // 런타임 소비: main.ts (accessLog), composition/runtime.ts (rag).
  accessLog: AccessLogSchema.optional(),
  rag: RagSchema.optional(),
  // Phase 32 W6 / Phase 41: 백엔드 경로 — claude-cli 단일. 문서화된 키라 허용만 한다 (분기 없음).
  provider: z.literal('claude-cli').optional(),
  cliBackend: z
    .strictObject({
      command: z.string().optional(),
    })
    .optional(),
});

export type ValidatedFinClawConfig = z.infer<typeof FinClawConfigSchema>;
