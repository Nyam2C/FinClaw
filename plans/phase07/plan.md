# Phase 7: 에이전트 코어 -- 도구 시스템 & 세션

> 복잡도: **L** | 소스 파일: ~12 | 테스트 파일: ~7 | 합계: **~19 파일**

---

## 1. 목표

AI 에이전트의 **도구 실행 계층(L5)**, **세션 관리(L3)**, **컨텍스트 윈도우 관리(L4)** 를 구현한다. 이 3개 계층은 AI가 외부 도구를 안전하게 호출하고, 대화 세션을 배타적으로 관리하며, 컨텍스트 예산을 초과하지 않도록 보장한다.

### L5 도구 계층

- **Tool Policy**: 9단계 정책 필터. 도구별 allow/deny/require-approval 규칙을 적용한다.
- **Tool Groups**: 논리적 도구 그룹핑(e.g., "finance", "system", "web"). 그룹 단위로 정책을 일괄 적용할 수 있다.
- **Tool Registry**: 도구 등록/조회/목록 관리. 메타데이터(이름, 설명, 입력 스키마, 그룹)를 포함한다.
- **System Prompt Builder**: 15+ 섹션 동적 프롬프트 조립. 금융 도메인 컨텍스트를 자동 주입한다.

### L3 세션 계층

- **Write Lock**: 파일 기반 뮤텍스(`fs.open('wx')`). 동일 세션에 대한 동시 쓰기를 방지한다.
- **Transcript Repair**: 손상된 트랜스크립트(잘린 JSON, 중복 엔트리)를 감지하고 복구한다.
- **Tool Result Guard**: 도구 실행 결과를 검증/새니타이즈하여 AI에 안전한 형태로 전달한다.

### L4 컨텍스트 계층

- **Context Window Guard**: 토큰 예산 강제. 현재 컨텍스트가 모델의 maxInputTokens를 초과하지 않도록 감시한다.
- **Compaction**: 컨텍스트 예산 초과 시 적응형 요약(adaptive summarization)으로 이전 대화를 압축한다.

FinClaw 금융 도메인 특화: 도구 그룹에 "finance" 카테고리(시세 조회, 포트폴리오 분석, 뉴스 검색), 시스템 프롬프트에 금융 규정 준수 가이드라인 섹션 추가.

---

## 2. OpenClaw 참조

| 참조 문서 경로                                      | 적용할 패턴                                                  |
| --------------------------------------------------- | ------------------------------------------------------------ |
| `openclaw_review/docs/agents/tool-policy.md`        | 9단계 정책 필터 파이프라인, allow/deny/require-approval 규칙 |
| `openclaw_review/docs/agents/tool-groups.md`        | 논리적 그룹핑, 그룹별 일괄 정책 적용                         |
| `openclaw_review/docs/agents/session-management.md` | 파일 기반 write lock, 트랜스크립트 구조                      |
| `openclaw_review/deep-dive/context-compaction.md`   | 적응형 요약 알고리즘, 토큰 예산 관리                         |
| `openclaw_review/docs/agents/system-prompt.md`      | 15+ 섹션 동적 프롬프트 조립 패턴                             |
| `openclaw_review/docs/agents/tool-result-guard.md`  | 결과 검증/새니타이즈, 크기 제한, 타입 보장                   |

**OpenClaw 대비 FinClaw 간소화 사항:**

- L3-L5 계층을 ~19 파일로 통합
- 스킬 핫 리로드 기능은 기본 수준만 구현
- 도구 승인(require-approval) 플로우는 콘솔 확인만 지원 (UI 연동 제외)
- 금융 도메인 전용 도구 그룹 및 시스템 프롬프트 섹션 추가

---

## 3. 생성할 파일

### 소스 파일 (12개)

```
src/agents/
├── tools/
│   ├── index.ts              # 도구 모듈 public API
│   ├── registry.ts           # 도구 등록/조회/목록
│   ├── policy.ts             # 9단계 정책 필터
│   ├── groups.ts             # 도구 그룹 정의 + 그룹별 정책
│   └── result-guard.ts       # 도구 실행 결과 검증/새니타이즈
├── session/
│   ├── index.ts              # 세션 모듈 public API
│   ├── write-lock.ts         # 파일 기반 배타적 잠금
│   └── transcript-repair.ts  # 트랜스크립트 손상 감지/복구
├── context/
│   ├── window-guard.ts       # 토큰 예산 감시
│   └── compaction.ts         # 적응형 요약 압축
├── system-prompt.ts          # 15+ 섹션 동적 프롬프트 빌더
└── skills/
    └── manager.ts            # 스킬 로딩/관리
```

### 테스트 파일 (7개)

```
src/agents/__tests__/
├── tool-registry.test.ts     # 도구 등록/조회 테스트
├── tool-policy.test.ts       # 9단계 정책 필터 테스트
├── tool-groups.test.ts       # 도구 그룹 + 정책 적용 테스트
├── result-guard.test.ts      # 결과 검증/새니타이즈 테스트
├── write-lock.test.ts        # 파일 잠금 배타성 테스트
├── transcript-repair.test.ts # 트랜스크립트 복구 테스트
└── compaction.test.ts        # 컨텍스트 압축 테스트
```

---

## 4. 핵심 인터페이스/타입

### 4.1 Tool Registry

```typescript
// src/agents/tools/registry.ts

/** 도구 입력 파라미터 스키마 (JSON Schema 서브셋) */
export interface ToolInputSchema {
  readonly type: 'object';
  readonly properties: Record<string, ToolPropertySchema>;
  readonly required?: readonly string[];
}

export interface ToolPropertySchema {
  readonly type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  readonly description: string;
  readonly enum?: readonly string[];
  readonly items?: ToolPropertySchema;
  readonly default?: unknown;
}

/** 도구 정의 */
export interface ToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly group: ToolGroupId;
  readonly inputSchema: ToolInputSchema;
  readonly requiresApproval: boolean;
  /** 금융 특화: 이 도구가 실제 거래를 수행하는지 여부 */
  readonly isTransactional: boolean;
  /** 금융 특화: 이 도구가 민감한 금융 데이터에 접근하는지 */
  readonly accessesSensitiveData: boolean;
}

/** 도구 실행 함수 */
export type ToolExecutor = (
  input: Record<string, unknown>,
  context: ToolExecutionContext,
) => Promise<ToolResult>;

/** 도구 실행 컨텍스트 */
export interface ToolExecutionContext {
  readonly sessionId: string;
  readonly userId: string;
  readonly channelId: string;
  readonly abortSignal: AbortSignal;
}

/** 도구 실행 결과 */
export interface ToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly metadata?: Record<string, unknown>;
}

/** 도구 등록 항목 */
export interface RegisteredTool {
  readonly definition: ToolDefinition;
  readonly executor: ToolExecutor;
  readonly registeredAt: Date;
  readonly source: 'built-in' | 'plugin' | 'skill';
}

/** 도구 레지스트리 인터페이스 */
export interface ToolRegistry {
  register(
    definition: ToolDefinition,
    executor: ToolExecutor,
    source?: RegisteredTool['source'],
  ): void;
  unregister(name: string): boolean;
  get(name: string): RegisteredTool | undefined;
  list(): readonly RegisteredTool[];
  listByGroup(group: ToolGroupId): readonly RegisteredTool[];
  has(name: string): boolean;

  /** 도구 실행 (정책 필터 + 결과 가드 적용) */
  execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<GuardedToolResult>;
}
```

### 4.2 Tool Policy (9-Step Filter)

```typescript
// src/agents/tools/policy.ts

/** 정책 판정 결과 */
export type PolicyVerdict = 'allow' | 'deny' | 'require-approval';

/** 정책 규칙 */
export interface PolicyRule {
  readonly pattern: string; // 도구 이름 glob 패턴 (e.g., "finance:*")
  readonly verdict: PolicyVerdict;
  readonly reason?: string;
  readonly priority: number; // 높을수록 우선
}

/** 정책 컨텍스트 */
export interface PolicyContext {
  readonly toolName: string;
  readonly toolDefinition: ToolDefinition;
  readonly userId: string;
  readonly channelId: string;
  readonly sessionId: string;
}

/** 정책 필터 단계 정의 */
export interface PolicyStage {
  readonly name: string;
  readonly evaluate: (ctx: PolicyContext, rules: readonly PolicyRule[]) => PolicyStageResult;
}

export interface PolicyStageResult {
  readonly verdict: PolicyVerdict | 'continue';
  readonly reason: string;
  readonly stage: string;
}

/**
 * 9단계 정책 필터 파이프라인
 *
 * Stage 1: 글로벌 deny 리스트 확인
 * Stage 2: 글로벌 allow 리스트 확인
 * Stage 3: 사용자별 deny 리스트 확인
 * Stage 4: 사용자별 allow 리스트 확인
 * Stage 5: 채널별 정책 확인
 * Stage 6: 그룹별 정책 확인
 * Stage 7: 도구별 명시적 정책 확인
 * Stage 8: 금융 안전 정책 (isTransactional -> require-approval)
 * Stage 9: 기본 정책 (allow)
 */
export function evaluateToolPolicy(
  ctx: PolicyContext,
  rules: readonly PolicyRule[],
  stages?: readonly PolicyStage[],
): PolicyEvaluationResult;

export interface PolicyEvaluationResult {
  readonly finalVerdict: PolicyVerdict;
  readonly stageResults: readonly PolicyStageResult[];
  readonly decidingStage: string;
  readonly reason: string;
}
```

### 4.3 Tool Groups

```typescript
// src/agents/tools/groups.ts

/** 도구 그룹 식별자 */
export type ToolGroupId =
  | 'finance' // 금융 도구 (시세 조회, 차트, 포트폴리오)
  | 'system' // 시스템 도구 (파일, 프로세스)
  | 'web' // 웹 도구 (검색, 페이지 읽기)
  | 'data' // 데이터 도구 (DB 쿼리, 캐시)
  | 'communication' // 커뮤니케이션 (알림, 메시지)
  | 'custom'; // 사용자 정의

/** 도구 그룹 정의 */
export interface ToolGroup {
  readonly id: ToolGroupId;
  readonly displayName: string;
  readonly description: string;
  readonly defaultPolicy: PolicyVerdict;
  /** 이 그룹의 도구가 시스템 프롬프트에 포함될 조건 */
  readonly includeInPromptWhen: 'always' | 'on-demand' | 'never';
}

/** 내장 그룹 정의 */
export const BUILT_IN_GROUPS: readonly ToolGroup[] = [
  {
    id: 'finance',
    displayName: '금융 도구',
    description: '시세 조회, 포트폴리오 분석, 뉴스 검색, 차트 생성',
    defaultPolicy: 'allow',
    includeInPromptWhen: 'always',
  },
  {
    id: 'system',
    displayName: '시스템 도구',
    description: '파일 시스템, 프로세스 관리, 환경 정보',
    defaultPolicy: 'require-approval',
    includeInPromptWhen: 'on-demand',
  },
  {
    id: 'web',
    displayName: '웹 도구',
    description: '웹 검색, 페이지 읽기, API 호출',
    defaultPolicy: 'allow',
    includeInPromptWhen: 'always',
  },
  {
    id: 'data',
    displayName: '데이터 도구',
    description: '데이터베이스 쿼리, 캐시 관리',
    defaultPolicy: 'require-approval',
    includeInPromptWhen: 'on-demand',
  },
  {
    id: 'communication',
    displayName: '커뮤니케이션 도구',
    description: '알림 발송, 메시지 전달',
    defaultPolicy: 'allow',
    includeInPromptWhen: 'always',
  },
  {
    id: 'custom',
    displayName: '사용자 정의 도구',
    description: '플러그인/스킬이 등록한 커스텀 도구',
    defaultPolicy: 'require-approval',
    includeInPromptWhen: 'on-demand',
  },
];
```

### 4.4 Session Write Lock

```typescript
// src/agents/session/write-lock.ts

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** 세션 잠금 결과 */
export interface LockResult {
  readonly acquired: boolean;
  readonly lockPath: string;
  readonly release: () => Promise<void>;
}

/** 세션 잠금 옵션 */
export interface LockOptions {
  readonly sessionDir: string;
  readonly sessionId: string;
  readonly timeoutMs?: number; // 잠금 대기 타임아웃 (기본: 5000ms)
  readonly staleAfterMs?: number; // 오래된 잠금 자동 해제 (기본: 300000ms = 5분)
}

/**
 * 파일 기반 배타적 잠금
 *
 * 알고리즘:
 * 1. fs.open(lockPath, 'wx') 로 exclusive 생성 시도
 * 2. 성공 -> 잠금 획득, PID + timestamp 기록
 * 3. 실패(EEXIST) -> 기존 잠금 파일의 stale 여부 확인
 *    - 생성 시간이 staleAfterMs 초과 -> 강제 삭제 후 재시도
 *    - 아니면 timeoutMs까지 폴링 대기 (100ms 간격)
 * 4. 타임아웃 -> acquired: false 반환
 * 5. release() 호출 시 잠금 파일 삭제
 */
export async function acquireWriteLock(options: LockOptions): Promise<LockResult>;
```

### 4.5 Transcript Repair

```typescript
// src/agents/session/transcript-repair.ts

/** 트랜스크립트 엔트리 */
export interface TranscriptEntry {
  readonly role: 'user' | 'assistant' | 'system' | 'tool';
  readonly content: string;
  readonly timestamp: string;
  readonly toolUseId?: string;
  readonly toolName?: string;
}

/** 트랜스크립트 손상 유형 */
export type CorruptionType =
  | 'truncated-json' // JSON이 중간에 잘림
  | 'duplicate-entry' // 동일 엔트리 중복
  | 'orphan-tool-result' // 대응하는 tool_use가 없는 tool_result
  | 'missing-tool-result' // tool_use 후 tool_result 누락
  | 'invalid-role-sequence'; // 잘못된 역할 순서 (e.g., tool_result without preceding assistant)

/** 손상 보고서 */
export interface CorruptionReport {
  readonly corruptions: readonly DetectedCorruption[];
  readonly isRecoverable: boolean;
}

export interface DetectedCorruption {
  readonly type: CorruptionType;
  readonly index: number;
  readonly description: string;
}

/**
 * 트랜스크립트 손상 감지
 */
export function detectCorruption(entries: readonly TranscriptEntry[]): CorruptionReport;

/**
 * 트랜스크립트 복구
 *
 * 복구 전략:
 * - truncated-json: 마지막 완전한 JSON 경계까지 자르기
 * - duplicate-entry: 중복 제거 (timestamp 기준)
 * - orphan-tool-result: 합성 tool_use 엔트리 삽입
 * - missing-tool-result: 합성 "[Tool result unavailable]" 삽입
 * - invalid-role-sequence: 순서 위반 엔트리 재배치 또는 제거
 */
export function repairTranscript(
  entries: readonly TranscriptEntry[],
  report: CorruptionReport,
): TranscriptEntry[];
```

### 4.6 Tool Result Guard

```typescript
// src/agents/tools/result-guard.ts

/** 가드된 도구 결과 */
export interface GuardedToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly wasTruncated: boolean;
  readonly wasRedacted: boolean;
  readonly originalSize: number;
  readonly guardedSize: number;
}

/** 결과 가드 옵션 */
export interface ResultGuardOptions {
  readonly maxContentLength: number; // 기본: 100_000 chars
  readonly redactPatterns: readonly RegExp[]; // 민감 정보 마스킹 패턴
  readonly allowHtml: boolean; // HTML 태그 허용 여부
  /** 금융 특화: 계좌번호/카드번호 자동 마스킹 */
  readonly redactFinancialData: boolean;
}

/**
 * 도구 실행 결과 가드
 *
 * 검증 단계:
 * 1. null/undefined 결과 -> "[No result returned]" 대체
 * 2. 문자열 변환 (비문자열 결과 JSON.stringify)
 * 3. 크기 제한 검사 -> 초과 시 truncation + "[truncated]" 접미사
 * 4. 민감 정보 마스킹 (redactPatterns + 금융 데이터)
 * 5. HTML 새니타이즈 (allowHtml=false 시)
 * 6. 최종 GuardedToolResult 반환
 */
export function guardToolResult(
  result: ToolResult | null | undefined,
  options: ResultGuardOptions,
): GuardedToolResult;

/** 내장 금융 데이터 마스킹 패턴 */
export const FINANCIAL_REDACT_PATTERNS: readonly RegExp[] = [
  /\b\d{4}[-\s]?\d{4}[-\s]?\d{4}[-\s]?\d{4}\b/g, // 카드번호
  /\b\d{3}-\d{2}-\d{4}\b/g, // SSN
  /\b\d{10,14}\b/g, // 계좌번호 (10-14자리)
];
```

### 4.7 Context Window Guard & Compaction

```typescript
// src/agents/context/window-guard.ts

/** 컨텍스트 윈도우 상태 */
export interface ContextWindowState {
  readonly currentTokens: number;
  readonly maxTokens: number;
  readonly usageRatio: number; // 0.0 ~ 1.0
  readonly status: 'safe' | 'warning' | 'critical' | 'exceeded';
  readonly compactionNeeded: boolean;
}

/** 윈도우 가드 설정 */
export interface WindowGuardConfig {
  readonly warningThreshold: number; // 기본: 0.7 (70%)
  readonly criticalThreshold: number; // 기본: 0.85 (85%)
  readonly reserveTokens: number; // 출력용 예약 토큰 (기본: 4096)
}

/**
 * 컨텍스트 윈도우 상태 평가
 */
export function evaluateContextWindow(
  currentTokens: number,
  model: ModelEntry,
  config: WindowGuardConfig,
): ContextWindowState;

// src/agents/context/compaction.ts

/** 압축 전략 */
export type CompactionStrategy =
  | 'summarize' // AI 요약 (가장 정확, 비용 발생)
  | 'truncate-oldest' // 가장 오래된 메시지 제거
  | 'truncate-tools' // 도구 결과만 축소
  | 'hybrid'; // summarize + truncate-tools 조합

/** 압축 옵션 */
export interface CompactionOptions {
  readonly strategy: CompactionStrategy;
  readonly targetTokens: number; // 압축 후 목표 토큰 수
  readonly preserveRecentMessages: number; // 최근 N개 메시지 보존
  readonly preserveSystemPrompt: boolean;
}

/** 압축 결과 */
export interface CompactionResult {
  readonly compactedEntries: TranscriptEntry[];
  readonly summary?: string; // 요약문 (strategy가 summarize일 때)
  readonly removedCount: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  readonly strategy: CompactionStrategy;
}

/**
 * 적응형 컨텍스트 압축
 *
 * 알고리즘:
 * 1. 현재 토큰 수와 목표 토큰 수의 차이 계산
 * 2. 차이가 작으면 (< 20%) truncate-tools로 충분
 * 3. 차이가 크면 (>= 20%) summarize 또는 hybrid 사용
 * 4. preserveRecentMessages만큼 최근 메시지는 압축 대상에서 제외
 * 5. systemPrompt는 항상 보존 (preserveSystemPrompt=true)
 * 6. 압축 후 실제 토큰 수 검증 -> 목표 미달 시 2차 압축
 */
export async function compactContext(
  entries: readonly TranscriptEntry[],
  options: CompactionOptions,
  summarizer: (text: string) => Promise<string>,
  tokenCounter: (text: string) => number,
): Promise<CompactionResult>;
```

### 4.8 System Prompt Builder

```typescript
// src/agents/system-prompt.ts

/** 시스템 프롬프트 섹션 */
export interface PromptSection {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly priority: number; // 높을수록 먼저 배치
  readonly required: boolean; // 필수 섹션 여부
  readonly tokenEstimate: number;
}

/** 시스템 프롬프트 빌더 컨텍스트 */
export interface PromptBuildContext {
  readonly userId: string;
  readonly channelId: string;
  readonly chatType: ChatType;
  readonly availableTools: readonly ToolDefinition[];
  readonly modelCapabilities: ModelCapabilities;
  readonly customInstructions?: string;
  /** 금융 특화: 사용자의 투자 성향 */
  readonly investmentProfile?: InvestmentProfile;
}

/** 금융 투자 성향 */
export interface InvestmentProfile {
  readonly riskTolerance: 'conservative' | 'moderate' | 'aggressive';
  readonly preferredMarkets: readonly string[];
  readonly complianceLevel: 'retail' | 'professional' | 'institutional';
}

/**
 * 15+ 섹션 동적 시스템 프롬프트 빌더
 *
 * 섹션 목록:
 * 1. identity - AI 정체성 및 역할
 * 2. capabilities - 사용 가능한 기능 목록
 * 3. tools - 등록된 도구 설명
 * 4. finance-context - 금융 도메인 맥락
 * 5. compliance - 금융 규정 준수 가이드
 * 6. risk-disclaimer - 투자 위험 고지
 * 7. user-context - 사용자 맞춤 정보
 * 8. channel-context - 채널별 행동 규칙
 * 9. formatting - 응답 형식 가이드
 * 10. language - 언어/톤 설정
 * 11. constraints - 행동 제한 사항
 * 12. examples - 응답 예시
 * 13. current-state - 현재 시장/시간 상태
 * 14. memory - 이전 대화 요약
 * 15. custom - 사용자 커스텀 지시사항
 */
export function buildSystemPrompt(ctx: PromptBuildContext): string;

/** 개별 섹션 생성 함수들 */
export function buildIdentitySection(): PromptSection;
export function buildToolsSection(tools: readonly ToolDefinition[]): PromptSection;
export function buildFinanceContextSection(): PromptSection;
export function buildComplianceSection(level: string): PromptSection;
export function buildRiskDisclaimerSection(): PromptSection;
```

---

## 5. 구현 상세

### 5.1 Tool Registry 구현

```typescript
// src/agents/tools/registry.ts

export class InMemoryToolRegistry implements ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();
  private readonly policyRules: PolicyRule[] = [];
  private readonly resultGuardOptions: ResultGuardOptions;

  constructor(options?: Partial<ResultGuardOptions>) {
    this.resultGuardOptions = {
      maxContentLength: 100_000,
      redactPatterns: [],
      allowHtml: false,
      redactFinancialData: true,
      ...options,
    };
  }

  register(
    definition: ToolDefinition,
    executor: ToolExecutor,
    source: RegisteredTool['source'] = 'built-in',
  ): void {
    if (this.tools.has(definition.name)) {
      throw new Error(`Tool already registered: ${definition.name}`);
    }
    this.tools.set(definition.name, {
      definition,
      executor,
      registeredAt: new Date(),
      source,
    });
  }

  async execute(
    name: string,
    input: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<GuardedToolResult> {
    const tool = this.tools.get(name);
    if (!tool) {
      return guardToolResult(
        { content: `Tool not found: ${name}`, isError: true },
        this.resultGuardOptions,
      );
    }

    // 1. 정책 평가
    const policyResult = evaluateToolPolicy(
      {
        toolName: name,
        toolDefinition: tool.definition,
        userId: context.userId,
        channelId: context.channelId,
        sessionId: context.sessionId,
      },
      this.policyRules,
    );

    if (policyResult.finalVerdict === 'deny') {
      return guardToolResult(
        { content: `Tool "${name}" denied: ${policyResult.reason}`, isError: true },
        this.resultGuardOptions,
      );
    }

    // 2. require-approval 처리 (향후 확장)
    if (policyResult.finalVerdict === 'require-approval') {
      // 현재는 로그만 남기고 허용
      console.warn(`[ToolRegistry] Tool "${name}" requires approval (auto-approved)`);
    }

    // 3. 도구 실행
    try {
      const result = await tool.executor(input, context);
      return guardToolResult(result, this.resultGuardOptions);
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      return guardToolResult(
        { content: `Tool execution failed: ${errMsg}`, isError: true },
        this.resultGuardOptions,
      );
    }
  }

  // ... list, get, unregister, has, listByGroup 구현 생략
}
```

### 5.2 9단계 정책 필터 구현

```typescript
// src/agents/tools/policy.ts

const DEFAULT_STAGES: readonly PolicyStage[] = [
  { name: 'global-deny', evaluate: evaluateGlobalDeny },
  { name: 'global-allow', evaluate: evaluateGlobalAllow },
  { name: 'user-deny', evaluate: evaluateUserDeny },
  { name: 'user-allow', evaluate: evaluateUserAllow },
  { name: 'channel-policy', evaluate: evaluateChannelPolicy },
  { name: 'group-policy', evaluate: evaluateGroupPolicy },
  { name: 'tool-policy', evaluate: evaluateToolSpecificPolicy },
  { name: 'finance-safety', evaluate: evaluateFinanceSafety },
  { name: 'default-policy', evaluate: evaluateDefault },
];

export function evaluateToolPolicy(
  ctx: PolicyContext,
  rules: readonly PolicyRule[],
  stages: readonly PolicyStage[] = DEFAULT_STAGES,
): PolicyEvaluationResult {
  const stageResults: PolicyStageResult[] = [];

  for (const stage of stages) {
    const result = stage.evaluate(ctx, rules);
    stageResults.push(result);

    // 'continue' 이외의 판정이 나오면 즉시 종료
    if (result.verdict !== 'continue') {
      return {
        finalVerdict: result.verdict,
        stageResults,
        decidingStage: stage.name,
        reason: result.reason,
      };
    }
  }

  // 모든 단계를 통과하면 기본 allow
  return {
    finalVerdict: 'allow',
    stageResults,
    decidingStage: 'fallthrough',
    reason: 'No matching policy rule found, defaulting to allow',
  };
}

/** Stage 8: 금융 안전 정책 (FinClaw 전용) */
function evaluateFinanceSafety(
  ctx: PolicyContext,
  _rules: readonly PolicyRule[],
): PolicyStageResult {
  // 거래 실행 도구는 반드시 승인 필요
  if (ctx.toolDefinition.isTransactional) {
    return {
      verdict: 'require-approval',
      reason: `Transactional tool "${ctx.toolName}" requires explicit approval`,
      stage: 'finance-safety',
    };
  }

  // 민감 금융 데이터 접근 도구는 경고 로그
  if (ctx.toolDefinition.accessesSensitiveData) {
    console.warn(
      `[Policy:finance-safety] Tool "${ctx.toolName}" accesses sensitive financial data`,
    );
  }

  return { verdict: 'continue', reason: '', stage: 'finance-safety' };
}

/** glob 패턴 매칭 (간이 구현: * 만 지원) */
function matchToolPattern(pattern: string, toolName: string): boolean {
  if (pattern === '*') return true;
  if (pattern.endsWith(':*')) {
    const prefix = pattern.slice(0, -2);
    return toolName.startsWith(prefix + ':');
  }
  return pattern === toolName;
}
```

### 5.3 파일 기반 Write Lock

```typescript
// src/agents/session/write-lock.ts

export async function acquireWriteLock(options: LockOptions): Promise<LockResult> {
  const { sessionDir, sessionId, timeoutMs = 5000, staleAfterMs = 300_000 } = options;

  const lockPath = path.join(sessionDir, `${sessionId}.lock`);
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    try {
      // 배타적 생성 시도 (O_CREAT | O_EXCL)
      const fd = await fs.open(lockPath, 'wx');
      const lockData = JSON.stringify({
        pid: process.pid,
        timestamp: new Date().toISOString(),
        sessionId,
      });
      await fd.writeFile(lockData);
      await fd.close();

      return {
        acquired: true,
        lockPath,
        release: async () => {
          try {
            await fs.unlink(lockPath);
          } catch {
            // 이미 해제된 경우 무시
          }
        },
      };
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;

      // 기존 잠금이 stale인지 확인
      try {
        const stat = await fs.stat(lockPath);
        const age = Date.now() - stat.mtimeMs;
        if (age > staleAfterMs) {
          // Stale lock 강제 해제
          await fs.unlink(lockPath);
          continue; // 재시도
        }
      } catch {
        continue; // stat 실패 시 재시도
      }

      // 대기 후 재시도
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  return {
    acquired: false,
    lockPath,
    release: async () => {},
  };
}
```

### 5.4 적응형 컨텍스트 압축

```typescript
// src/agents/context/compaction.ts

export async function compactContext(
  entries: readonly TranscriptEntry[],
  options: CompactionOptions,
  summarizer: (text: string) => Promise<string>,
  tokenCounter: (text: string) => number,
): Promise<CompactionResult> {
  const totalTokens = entries.reduce((sum, e) => sum + tokenCounter(e.content), 0);
  const excess = totalTokens - options.targetTokens;

  if (excess <= 0) {
    return {
      compactedEntries: [...entries],
      removedCount: 0,
      beforeTokens: totalTokens,
      afterTokens: totalTokens,
      strategy: options.strategy,
    };
  }

  // 보존 대상과 압축 대상 분리
  const preserveCount = options.preserveRecentMessages;
  const toPreserve = entries.slice(-preserveCount);
  const toCompact = entries.slice(0, entries.length - preserveCount);

  let strategy = options.strategy;

  // 적응형 전략 선택 (hybrid 모드)
  if (strategy === 'hybrid') {
    const excessRatio = excess / totalTokens;
    strategy = excessRatio < 0.2 ? 'truncate-tools' : 'summarize';
  }

  let compacted: TranscriptEntry[];
  let summary: string | undefined;

  switch (strategy) {
    case 'truncate-tools': {
      // 도구 결과만 축소 ("[Result truncated]" 대체)
      compacted = toCompact.map((entry) =>
        entry.role === 'tool'
          ? { ...entry, content: '[Result truncated for context management]' }
          : entry,
      );
      break;
    }

    case 'truncate-oldest': {
      // 가장 오래된 메시지부터 제거
      let removed = 0;
      let removedTokens = 0;
      compacted = [];
      for (let i = toCompact.length - 1; i >= 0; i--) {
        if (removedTokens >= excess) {
          compacted.unshift(toCompact[i]);
        } else {
          removedTokens += tokenCounter(toCompact[i].content);
          removed++;
        }
      }
      break;
    }

    case 'summarize': {
      // AI 요약으로 압축
      const textToSummarize = toCompact.map((e) => `[${e.role}]: ${e.content}`).join('\n');
      summary = await summarizer(textToSummarize);
      compacted = [
        {
          role: 'system' as const,
          content: `[Previous conversation summary]\n${summary}`,
          timestamp: new Date().toISOString(),
        },
      ];
      break;
    }

    default:
      compacted = [...toCompact];
  }

  const result = [...compacted, ...toPreserve];
  const afterTokens = result.reduce((sum, e) => sum + tokenCounter(e.content), 0);

  return {
    compactedEntries: result,
    summary,
    removedCount: entries.length - result.length,
    beforeTokens: totalTokens,
    afterTokens,
    strategy,
  };
}
```

---

## 6. 선행 조건

| Phase                   | 구체적 산출물                                                      | 필요 이유                                     |
| ----------------------- | ------------------------------------------------------------------ | --------------------------------------------- |
| Phase 1 (타입 시스템)   | `ToolDefinition`, `TranscriptEntry`, `ChatType` 타입               | 도구/세션 인터페이스의 타입 기반              |
| Phase 2 (인프라)        | `Logger`, `FinClawError`, `retry()` 유틸리티                       | 도구 실행 에러 처리, 잠금 재시도 로깅         |
| Phase 3 (설정)          | `ToolPolicyConfig`, `SessionConfig`, `CompactionConfig`            | 정책 규칙, 세션 디렉토리 경로, 압축 임계값    |
| Phase 5 (채널/플러그인) | `PluginRegistry` (tools 슬롯), Hook system (`tool:before-execute`) | 플러그인이 도구를 등록하는 경로, 도구 실행 훅 |
| Phase 6 (모델 선택)     | `ModelEntry` (contextWindow, maxOutputTokens), `resolveModel()`    | 컨텍스트 윈도우 가드, 압축 시 모델 호출       |

---

## 7. 산출물 및 검증

### 테스트 가능한 결과물

| #   | 산출물                                      | 검증 방법                                                                     |
| --- | ------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | `InMemoryToolRegistry`                      | 단위 테스트: register/get/list/listByGroup/unregister                         |
| 2   | `ToolRegistry.execute()`                    | 통합 테스트: 정책 평가 -> 도구 실행 -> 결과 가드 파이프라인                   |
| 3   | `evaluateToolPolicy()` 9단계                | 단위 테스트: 각 단계별 verdict 확인, 우선순위 순서 검증                       |
| 4   | 금융 안전 정책 (Stage 8)                    | 단위 테스트: isTransactional=true -> require-approval                         |
| 5   | `guardToolResult()`                         | 단위 테스트: 크기 제한, 민감 정보 마스킹, HTML 새니타이즈, 금융 데이터 마스킹 |
| 6   | `acquireWriteLock()`                        | 단위 테스트: 잠금 획득, 이중 잠금 방지, stale lock 감지, 타임아웃             |
| 7   | `detectCorruption()` + `repairTranscript()` | 단위 테스트: 5종 손상 유형 감지 + 복구                                        |
| 8   | `evaluateContextWindow()`                   | 단위 테스트: safe/warning/critical/exceeded 상태 전환                         |
| 9   | `compactContext()` 4종 전략                 | 단위 테스트: summarize, truncate-oldest, truncate-tools, hybrid 각각 검증     |
| 10  | `buildSystemPrompt()`                       | 단위 테스트: 15+ 섹션 포함 확인, 금융 섹션 존재 확인                          |

### 검증 명령어

```bash
# 단위 테스트
pnpm test -- --filter='src/agents/__tests__/tool-*' --filter='src/agents/__tests__/write-*' --filter='src/agents/__tests__/compaction*'

# 타입 체크
pnpm typecheck

# 커버리지 (목표: branches 80%+)
pnpm test:coverage -- --filter='src/agents/**'
```

---

## 8. 복잡도 및 예상 파일 수

| 항목            | 값                                                                                   |
| --------------- | ------------------------------------------------------------------------------------ |
| **복잡도**      | **L**                                                                                |
| **소스 파일**   | 12개 (`tools/` 5 + `session/` 3 + `context/` 2 + `system-prompt.ts` 1 + `skills/` 1) |
| **테스트 파일** | 7개                                                                                  |
| **총 파일 수**  | **~19개**                                                                            |
| **예상 LOC**    | 소스 ~1,600 / 테스트 ~1,200 / 합계 ~2,800                                            |
| **새 의존성**   | 없음 (Node.js 내장 모듈만 사용)                                                      |
| **예상 소요**   | 2-3일                                                                                |

### 복잡도 근거 (L)

- 9단계 정책 필터는 단계별 독립적이나 우선순위/조합 테스트 경우의 수가 많음
- 파일 기반 write lock은 race condition 테스트가 까다로움 (동시 접근 시뮬레이션)
- 트랜스크립트 복구는 5종 손상 유형에 대한 다양한 엣지 케이스 존재
- 적응형 압축은 4종 전략 + AI 요약 모킹 + 토큰 카운팅 로직 포함
- 시스템 프롬프트 빌더는 15+ 섹션의 동적 조립 + 토큰 예산 내 피팅 로직
- Phase 5(플러그인 훅), Phase 6(모델 정보)과의 통합 지점이 다수 존재
