/** FinClaw 루트 설정 타입 — 런타임이 실제로 읽는 키만 둔다 (zod-schema.ts 와 lockstep). */
export interface FinClawConfig {
  /** cli/commands/tui.ts 가 auth.token 소비. */
  gateway?: GatewayConfig;
  /** Phase 30 C4: access-log retention (SQLite 행 보존 기간). */
  accessLog?: AccessLogConfig;
  /** Phase 30 D3: RAG re-ranking 토글. */
  rag?: RagConfig;
  /** Phase 32 W6: 백엔드 경로 — claude-cli 단일. 문서화된 키라 허용만 한다 (분기 없음). */
  provider?: 'claude-cli';
  /** Phase 32 W6: claude-cli 백엔드 옵션. */
  cliBackend?: CliBackendOptions;
}

/** Phase 32 W6: claude-cli 백엔드 config 오버라이드. Phase 46: 타임아웃·워치독은 코드 상수 (D8). */
export interface CliBackendOptions {
  command?: string;
}

export interface AccessLogConfig {
  /** 보존 기간 (일). 기본 30. 매일 04:00 (또는 24h interval) 에 oldest 삭제. */
  readonly retentionDays?: number;
}

export interface RagConfig {
  rerank?: {
    /** 기본 true. false 면 1차 hybrid 결과를 그대로 사용. */
    readonly enabled?: boolean;
    /** 1차 hybrid topK (기본 10). reranker 가 후보 풀로 사용. */
    readonly topKFirst?: number;
  };
}

export interface GatewayConfig {
  auth?: { token?: string };
}

export interface ConfigValidationIssue {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}
