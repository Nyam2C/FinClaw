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

### 1.1 ToolDefinition 타입 충돌 해소

`@finclaw/types/agent.ts`에 이미 3필드 `ToolDefinition { name, description, inputSchema }`이 존재한다. 본 plan의 7필드 ToolDefinition(group, requiresApproval, isTransactional, accessesSensitiveData 추가)은 이와 충돌하므로 다음과 같이 해소한다.

- plan의 7필드 타입을 **`RegisteredToolDefinition`**으로 개명
- `RegisteredToolDefinition extends ToolDefinition` (기존 3필드 상속)
- API 전송 시 `toApiToolDefinition(reg: RegisteredToolDefinition): ToolDefinition` 변환 유틸 제공

```typescript
// src/agents/tools/registry.ts
import type { ToolDefinition } from '@finclaw/types/agent.js';

/** Phase 7 확장 도구 정의 — 기존 ToolDefinition 3필드를 상속 */
export interface RegisteredToolDefinition extends ToolDefinition {
  readonly group: ToolGroupId;
  readonly requiresApproval: boolean;
  readonly isTransactional: boolean;
  readonly accessesSensitiveData: boolean;
  /** 도구별 실행 타임아웃 (ms). 미지정 시 기본 30_000 */
  readonly timeoutMs?: number;
  /** 외부 API 호출 도구 여부 (true이면 CircuitBreaker 적용) */
  readonly isExternal?: boolean;
}

/** RegisteredToolDefinition → ToolDefinition 변환 (LLM API 전송용) */
export function toApiToolDefinition(reg: RegisteredToolDefinition): ToolDefinition {
  return { name: reg.name, description: reg.description, inputSchema: reg.inputSchema };
}
```

> **영향 범위**: §4.1의 `ToolDefinition` 참조를 모두 `RegisteredToolDefinition`으로 교체. `ToolRegistry.register()`, `RegisteredTool.definition`, `PolicyContext.toolDefinition` 등의 타입이 변경된다. `PromptBuildContext.availableTools`는 API 전송 직전에 `toApiToolDefinition()`으로 변환하므로 기존 `ToolDefinition[]`을 유지한다.

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

### 5.1.1 execute() 안전성 보강

`ToolRegistry.execute()` 내부에 3개 안전 단계를 추가한다. 모두 기존 코드베이스 인프라를 재사용하며 새 의존성은 없다.

**① Zod v4 입력 검증** — 코드베이스에 이미 `zod/v4` 존재

```typescript
import { z } from 'zod/v4';

// execute() 내부, 정책 평가 전
if (tool.definition.inputSchema) {
  const schema = z.object(
    Object.fromEntries(
      Object.entries(tool.definition.inputSchema.properties ?? {}).map(([k, v]) => [
        k,
        jsonSchemaToZod(v),
      ]),
    ),
  );
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    return guardToolResult(
      { content: `Invalid input: ${parsed.error.message}`, isError: true },
      this.resultGuardOptions,
    );
  }
}
```

**② 도구별 타임아웃** — 수동 AbortController 조합 (`AbortSignal.any()` 메모리 누수 회피)

```typescript
const toolTimeout = tool.definition.timeoutMs ?? 30_000;
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), toolTimeout);

// 호출자의 abortSignal도 연결
const onExternalAbort = () => controller.abort();
context.abortSignal.addEventListener('abort', onExternalAbort, { once: true });

try {
  const mergedCtx = { ...context, abortSignal: controller.signal };
  const result = await tool.executor(input, mergedCtx);
  return guardToolResult(result, this.resultGuardOptions);
} finally {
  clearTimeout(timer);
  context.abortSignal.removeEventListener('abort', onExternalAbort);
}
```

**③ CircuitBreaker** — 외부 API 도구용 (`@finclaw/infra/circuit-breaker.ts` 재사용)

```typescript
import { createCircuitBreaker, type CircuitBreaker } from '@finclaw/infra/circuit-breaker.js';

// InMemoryToolRegistry 클래스에 필드 추가
private readonly breakers = new Map<string, CircuitBreaker>();

// execute() 내부, 도구 실행 직전
if (tool.definition.isExternal) {
  const breaker = this.breakers.get(name)
    ?? this.breakers.set(name, createCircuitBreaker()).get(name)!;
  return breaker.execute(() => tool.executor(input, mergedCtx))
    .then(r => guardToolResult(r, this.resultGuardOptions));
}
```

> `RegisteredToolDefinition`에 추가되는 필드: `timeoutMs?: number`, `isExternal?: boolean` (§1.1 참조)

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
  let pendingApproval: PolicyStageResult | undefined;

  for (const stage of stages) {
    const result = stage.evaluate(ctx, rules);
    stageResults.push(result);

    switch (result.verdict) {
      // deny → 즉시 중단 (후속 단계 무시)
      case 'deny':
        return {
          finalVerdict: 'deny',
          stageResults,
          decidingStage: stage.name,
          reason: result.reason,
        };

      // require-approval → 누적, 파이프라인 끝에서 적용
      case 'require-approval':
        pendingApproval ??= result;
        break;

      // allow / continue → 계속 진행 (후속 finance-safety 단계 보장)
      default:
        break;
    }
  }

  // 파이프라인 완주 후 누적된 require-approval 적용
  if (pendingApproval) {
    return {
      finalVerdict: 'require-approval',
      stageResults,
      decidingStage: pendingApproval.stage,
      reason: pendingApproval.reason,
    };
  }

  // 모든 단계를 통과하고 누적 승인 요청도 없으면 기본 allow
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

### 5.3.1 Write Lock 보강

기존 §5.3의 stale 감지가 시간 기반(`staleAfterMs`)만 사용하여 프로세스 비정상 종료 시 최대 5분 대기가 발생한다. `gateway-lock.ts`의 `isProcessAlive` 패턴을 재사용하여 즉시 감지한다.

**① PID 생존 확인** — `gateway-lock.ts`의 `isProcessAlive` 패턴 재사용

```typescript
// stale 검사 부분 교체
const info = JSON.parse(await fs.readFile(lockPath, 'utf-8'));
if (!isProcessAlive(info.pid)) {
  // 프로세스가 죽었으면 시간과 무관하게 즉시 stale 처리
  await fs.unlink(lockPath);
  continue;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
```

**② 재진입 잠금** — `HeldLock.count` 참조 카운팅

```typescript
interface HeldLock {
  lockPath: string;
  pid: number;
  count: number; // 참조 카운트
  release(): Promise<void>;
}

// 동일 프로세스가 이미 잠금을 보유한 경우
if (info.pid === process.pid && options.allowReentrant) {
  held.count++;
  return {
    acquired: true,
    lockPath,
    release: async () => {
      held.count--;
      if (held.count <= 0) await fs.unlink(lockPath);
    },
  };
}
```

**③ 시그널 핸들러 정리** — SIGINT/SIGTERM/exit 핸들러 등록 + release 시 해제

```typescript
const cleanup = async () => {
  try {
    await fs.unlink(lockPath);
  } catch {
    /* ignore */
  }
};
const onSignal = () => {
  cleanup();
  process.exit(1);
};

process.once('SIGINT', onSignal);
process.once('SIGTERM', onSignal);
process.once('exit', cleanup);

// release() 에서 핸들러 해제
const release = async () => {
  process.removeListener('SIGINT', onSignal);
  process.removeListener('SIGTERM', onSignal);
  process.removeListener('exit', cleanup);
  await cleanup();
};
```

> `LockOptions`에 추가되는 필드: `allowReentrant?: boolean`, `maxHoldMs?: number`

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

### 5.4.1 Compaction 보강

기존 §5.4의 압축이 실패하거나 목표 토큰에 도달하지 못하는 경우를 대비한 3단계 폴백과 안전 상수를 추가한다.

**① 안전 상수**

```typescript
/** 토큰 카운터 오차 보정 (1.2 = 20% 마진) */
const SAFETY_MARGIN = 1.2;
/** 요약 생성 시 소비되는 추가 토큰 (요약 프롬프트 + 출력) */
const SUMMARIZATION_OVERHEAD_TOKENS = 4096;

// targetTokens 계산 시 적용
const safeTarget = Math.floor(options.targetTokens / SAFETY_MARGIN) - SUMMARIZATION_OVERHEAD_TOKENS;
```

**② 3단계 폴백 요약**

```typescript
async function compactWithFallback(
  toCompact: readonly TranscriptEntry[],
  safeTarget: number,
  summarizer: (text: string) => Promise<string>,
  tokenCounter: (text: string) => number,
): Promise<{ entries: TranscriptEntry[]; summary?: string; strategy: CompactionStrategy }> {
  // 1단계: Full summarize — 전체를 한 번에 요약
  try {
    const text = toCompact.map((e) => `[${e.role}]: ${e.content}`).join('\n');
    const summary = await summarizer(text);
    if (tokenCounter(summary) <= safeTarget) {
      return {
        entries: [
          {
            role: 'system',
            content: `[Previous conversation summary]\n${summary}`,
            timestamp: new Date().toISOString(),
          },
        ],
        summary,
        strategy: 'summarize',
      };
    }
  } catch {
    /* 요약 실패 → 2단계로 */
  }

  // 2단계: Partial — 청크 분할 후 개별 요약
  const chunkCount = Math.max(
    2,
    Math.ceil(tokenCounter(toCompact.map((e) => e.content).join('')) / safeTarget),
  );
  try {
    const chunkSize = Math.ceil(toCompact.length / chunkCount);
    const summaries: string[] = [];
    for (let i = 0; i < toCompact.length; i += chunkSize) {
      const chunk = toCompact.slice(i, i + chunkSize);
      const text = chunk.map((e) => `[${e.role}]: ${e.content}`).join('\n');
      summaries.push(await summarizer(text));
    }
    const combined = summaries.join('\n---\n');
    if (tokenCounter(combined) <= safeTarget) {
      return {
        entries: [
          {
            role: 'system',
            content: `[Previous conversation summary]\n${combined}`,
            timestamp: new Date().toISOString(),
          },
        ],
        summary: combined,
        strategy: 'summarize',
      };
    }
  } catch {
    /* 부분 요약 실패 → 3단계로 */
  }

  // 3단계: Fallback — truncate-oldest (AI 호출 없이 안전하게 후퇴)
  let removed = 0;
  let removedTokens = 0;
  const kept: TranscriptEntry[] = [];
  for (let i = toCompact.length - 1; i >= 0; i--) {
    if (removedTokens >= tokenCounter(toCompact.map((e) => e.content).join('')) - safeTarget) {
      kept.unshift(toCompact[i]);
    } else {
      removedTokens += tokenCounter(toCompact[i].content);
      removed++;
    }
  }
  return { entries: kept, strategy: 'truncate-oldest' };
}
```

**③ 적응형 청크 비율** — 이전 압축 비율에 따라 청크 수를 자동 결정

```typescript
// 압축 비율 = afterTokens / beforeTokens
// 비율이 높으면(요약이 길면) 다음번에 더 많은 청크로 분할
const chunkCount = Math.max(2, Math.ceil(1 / compressionRatio));
```

---

## 6. 선행 조건

| Phase                   | 구체적 산출물                                                                                         | 필요 이유                                                                               |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Phase 1 (타입 시스템)   | `ToolDefinition`, `TranscriptEntry`, `ChatType` 타입                                                  | 도구/세션 인터페이스의 타입 기반                                                        |
| Phase 2 (인프라)        | `Logger`, `FinClawError`, `retry()`, `CircuitBreaker`, `gateway-lock` PID 패턴, `fs-safe`, `EventBus` | 도구 실행 에러 처리, 잠금 재시도 로깅, 외부 API 보호, stale lock 즉시 감지, 이벤트 발행 |
| Phase 3 (설정)          | `ToolPolicyConfig`, `SessionConfig`, `CompactionConfig`                                               | 정책 규칙, 세션 디렉토리 경로, 압축 임계값                                              |
| Phase 5 (채널/플러그인) | `PluginRegistry` (tools 슬롯), Hook system (`tool:before-execute`)                                    | 플러그인이 도구를 등록하는 경로, 도구 실행 훅                                           |
| Phase 6 (모델 선택)     | `ModelEntry` (contextWindow, maxOutputTokens), `resolveModel()`                                       | 컨텍스트 윈도우 가드, 압축 시 모델 호출                                                 |

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
| **예상 LOC**    | 소스 ~2,000 / 테스트 ~1,500 / 합계 ~3,500                                            |
| **새 의존성**   | 없음 (Node.js 내장 모듈 + 기존 인프라만 사용)                                        |
| **예상 소요**   | 3-4일                                                                                |

### 복잡도 근거 (L)

- 9단계 정책 필터는 단계별 독립적이나 우선순위/조합 테스트 경우의 수가 많음
- 파일 기반 write lock은 race condition 테스트가 까다로움 (동시 접근 시뮬레이션)
- 트랜스크립트 복구는 5종 손상 유형에 대한 다양한 엣지 케이스 존재
- 적응형 압축은 4종 전략 + AI 요약 모킹 + 토큰 카운팅 로직 포함
- 시스템 프롬프트 빌더는 15+ 섹션의 동적 조립 + 토큰 예산 내 피팅 로직
- Phase 5(플러그인 훅), Phase 6(모델 정보)과의 통합 지점이 다수 존재

---

## 9. 이벤트 시스템 통합

기존 `FinClawEventMap` (17종, `packages/infra/src/events.ts`)에 Phase 7 이벤트 ~15종을 추가한다. 기존 `EventBus` 인프라(`createTypedEmitter`, `getEventBus`)를 그대로 재사용한다.

### 9.1 추가 이벤트 정의

```typescript
// packages/infra/src/events.ts — FinClawEventMap에 추가

/** === Phase 7: 도구 시스템 이벤트 === */

/** 도구 등록 */
'tool:register': (name: string, group: string, source: string) => void;
/** 도구 등록 해제 */
'tool:unregister': (name: string) => void;
/** 도구 실행 시작 */
'tool:execute:start': (name: string, sessionId: string) => void;
/** 도구 실행 완료 */
'tool:execute:end': (name: string, sessionId: string, durationMs: number) => void;
/** 도구 실행 에러 */
'tool:execute:error': (name: string, sessionId: string, error: string) => void;
/** 도구 실행 타임아웃 */
'tool:execute:timeout': (name: string, sessionId: string, timeoutMs: number) => void;
/** 정책 판정 */
'tool:policy:verdict': (name: string, verdict: string, stage: string) => void;
/** 정책 deny */
'tool:policy:deny': (name: string, reason: string) => void;
/** CircuitBreaker 상태 변경 */
'tool:circuit:change': (name: string, from: string, to: string) => void;

/** === Phase 7: 세션 이벤트 === */

/** 세션 잠금 획득 */
'session:lock:acquire': (sessionId: string, pid: number) => void;
/** 세션 잠금 해제 */
'session:lock:release': (sessionId: string) => void;
/** Stale 잠금 감지 */
'session:lock:stale': (sessionId: string, stalePid: number) => void;

/** === Phase 7: 컨텍스트 이벤트 === */

/** 컨텍스트 윈도우 상태 변경 */
'context:window:status': (status: string, usageRatio: number) => void;
/** 컨텍스트 압축 실행 */
'context:compact': (strategy: string, beforeTokens: number, afterTokens: number) => void;
/** 컨텍스트 압축 폴백 */
'context:compact:fallback': (fromStrategy: string, toStrategy: string) => void;
```

### 9.2 발행 위치

| 이벤트                                 | 발행 위치                                           |
| -------------------------------------- | --------------------------------------------------- |
| `tool:register` / `tool:unregister`    | `InMemoryToolRegistry.register()` / `.unregister()` |
| `tool:execute:start` / `end` / `error` | `InMemoryToolRegistry.execute()`                    |
| `tool:execute:timeout`                 | §5.1.1 타임아웃 핸들러                              |
| `tool:policy:verdict` / `deny`         | `evaluateToolPolicy()` 반환 직후                    |
| `tool:circuit:change`                  | CircuitBreaker 상태 전이 시                         |
| `session:lock:*`                       | `acquireWriteLock()` / `release()`                  |
| `context:window:status`                | `evaluateContextWindow()`                           |
| `context:compact` / `compact:fallback` | `compactContext()` / `compactWithFallback()`        |

---

## 10. 플러그인 훅 확장

기존 `PluginHookName` (9종, `packages/types/src/plugin.ts`)에 도구 실행 훅 2종을 추가한다. `createHookRunner` 3모드(`void`, `modifying`, `sync`)를 그대로 활용한다.

### 10.1 추가 훅

```typescript
// packages/types/src/plugin.ts — PluginHookName에 추가
| 'beforeToolExecute'   // modifying: 입력 변환, 실행 차단 가능
| 'afterToolExecute';   // modifying: 결과 변환, 메트릭 수집 가능
```

### 10.2 페이로드 타입

```typescript
// src/agents/tools/registry.ts

/** beforeToolExecute 훅 페이로드 */
export interface BeforeToolExecutePayload {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly context: ToolExecutionContext;
  /** false로 설정하면 실행을 차단 (deny와 유사) */
  skip?: boolean;
  /** skip=true일 때 반환할 대체 결과 */
  skipResult?: ToolResult;
}

/** afterToolExecute 훅 페이로드 */
export interface AfterToolExecutePayload {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly context: ToolExecutionContext;
  result: GuardedToolResult;
  readonly durationMs: number;
}
```

### 10.3 적용 위치

```typescript
// InMemoryToolRegistry.execute() 내부

// 정책 평가 후, 실행 전
const beforePayload = await this.hooks.beforeToolExecute.fire({
  toolName: name,
  input,
  context,
});
if (beforePayload.skip) {
  return guardToolResult(
    beforePayload.skipResult ?? { content: 'Skipped', isError: false },
    this.resultGuardOptions,
  );
}

// 실행 후, 반환 전
const afterPayload = await this.hooks.afterToolExecute.fire({
  toolName: name,
  input,
  context,
  result: guardedResult,
  durationMs,
});
return afterPayload.result;
```

---

## 11. 모듈별 보강 사항

기존 §4.5, §4.6, §4.7에 정의된 모듈의 누락 사항을 보강한다.

### 11.1 Transcript Repair 보강

- **도구 이름 검증**: `toolName`이 레지스트리에 존재하는지 확인. 미등록 도구 이름은 `"[unknown-tool]"`로 치환
- **orphan tool_result 처리**: 대응하는 `tool_use`가 없는 `tool_result`에 합성 `tool_use` 삽입 시, `toolName`을 content에서 추출 시도
- **abort 인식 복구**: `abortSignal`로 중단된 실행의 불완전 엔트리를 `"[Execution aborted]"` content로 교체

```typescript
// detectCorruption() 내부에 추가
// abort로 인한 빈 content 감지
if (entry.role === 'tool' && entry.content === '') {
  corruptions.push({
    type: 'missing-tool-result',
    index: i,
    description: 'Empty tool result (possibly aborted)',
  });
}
```

### 11.2 Result Guard 보강

- **도구 이름 검증**: `toolName`이 유효하지 않으면 결과에 경고 메타데이터 추가
- **JSON 제어 문자 제거**: `\u0000`~`\u001f` (탭/개행 제외) 자동 제거
- **details 필드 제거**: `ToolResult.metadata.details`에 내부 스택 트레이스가 포함될 수 있으므로 외부 반환 전 제거

```typescript
// guardToolResult() 내부에 추가

// JSON 제어 문자 제거 (탭 \t, 개행 \n, 캐리지리턴 \r 제외)
content = content.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

// 내부 details 필드 제거
if (result?.metadata) {
  const { details, ...safeMeta } = result.metadata as Record<string, unknown>;
  // safeMeta만 반환
}
```

### 11.3 Context Window Guard 보강

- **소스 트래킹**: 토큰 소비량을 소스별(system prompt, tools, conversation, summary)로 분리 추적

```typescript
export interface TokenBreakdown {
  readonly systemPrompt: number;
  readonly toolResults: number;
  readonly conversation: number;
  readonly summary: number;
}

export interface ContextWindowState {
  // ... 기존 필드
  readonly breakdown: TokenBreakdown;
}
```

- **절대 최소 임계치**: 모델 contextWindow와 무관하게 적용하는 하한값

```typescript
/** 절대 최소 임계치 — 이 이하로는 압축하지 않음 */
const ABSOLUTE_MIN_TOKENS = {
  small: 16_384, // 소형 모델 (contextWindow < 32K)
  standard: 32_768, // 표준 모델 (contextWindow >= 32K)
} as const;
```

---

## 12. 구현 순서

4-Part 의존 관계 기반. 각 Part는 이전 Part 완료를 전제한다.

### Part 1: 기반 타입 & 레지스트리 (Day 1)

| 순서 | 모듈                                    | 주요 작업                                    |
| ---- | --------------------------------------- | -------------------------------------------- |
| 1-1  | `RegisteredToolDefinition`              | §1.1 타입 정의, `toApiToolDefinition()` 유틸 |
| 1-2  | `ToolGroupId`, `ToolGroup`              | §4.3 그룹 정의 + `BUILT_IN_GROUPS`           |
| 1-3  | `InMemoryToolRegistry`                  | §5.1 register/get/list/unregister            |
| 1-4  | `ToolPropertySchema`, `ToolInputSchema` | §4.1 스키마 타입                             |

```bash
# Part 1 검증
pnpm typecheck
pnpm test -- --filter='tool-registry'
```

### Part 2: 정책 & 실행 파이프라인 (Day 1-2)

| 순서 | 모듈                      | 주요 작업                                   |
| ---- | ------------------------- | ------------------------------------------- |
| 2-1  | `evaluateToolPolicy()`    | §5.2 deny-first 하이브리드 파이프라인       |
| 2-2  | `evaluateFinanceSafety()` | §5.2 Stage 8 금융 안전 정책                 |
| 2-3  | `guardToolResult()`       | §4.6 + §11.2 결과 가드 + 보강               |
| 2-4  | `execute()` 안전성        | §5.1.1 Zod 검증 + 타임아웃 + CircuitBreaker |
| 2-5  | 플러그인 훅 통합          | §10 beforeToolExecute / afterToolExecute    |

```bash
# Part 2 검증
pnpm test -- --filter='tool-policy' --filter='result-guard'
```

### Part 3: 세션 관리 (Day 2)

| 순서 | 모듈                 | 주요 작업                                     |
| ---- | -------------------- | --------------------------------------------- |
| 3-1  | `acquireWriteLock()` | §5.3 + §5.3.1 PID 생존 확인 + 재진입 + 시그널 |
| 3-2  | `detectCorruption()` | §4.5 + §11.1 손상 감지 + abort 인식           |
| 3-3  | `repairTranscript()` | §4.5 + §11.1 복구 + 도구 이름 검증            |

```bash
# Part 3 검증
pnpm test -- --filter='write-lock' --filter='transcript-repair'
```

### Part 4: 컨텍스트 관리 & 시스템 프롬프트 (Day 2-3)

| 순서 | 모듈                      | 주요 작업                                        |
| ---- | ------------------------- | ------------------------------------------------ |
| 4-1  | `evaluateContextWindow()` | §4.7 + §11.3 상태 평가 + 소스 트래킹 + 절대 최소 |
| 4-2  | `compactContext()`        | §5.4 + §5.4.1 적응형 압축 + 3단계 폴백           |
| 4-3  | `buildSystemPrompt()`     | §4.8 15+ 섹션 동적 빌더                          |
| 4-4  | 이벤트 통합               | §9 전체 이벤트 발행 연결                         |

```bash
# Part 4 검증
pnpm test -- --filter='compaction' --filter='window-guard'
pnpm typecheck
```

---

## 13. 보충 참고 사항

### 13.1 System Prompt Builder `mode` 파라미터

```typescript
/** 프롬프트 빌드 모드 */
export type PromptBuildMode = 'full' | 'minimal' | 'none';

// buildSystemPrompt()에 mode 파라미터 추가
export function buildSystemPrompt(ctx: PromptBuildContext, mode?: PromptBuildMode): string;
// - full: 15+ 섹션 전체 (기본값)
// - minimal: identity + tools + constraints만
// - none: 빈 문자열 반환 (테스트용)
```

### 13.2 도구 루프 감지

동일 도구가 짧은 시간 내에 반복 호출되는 패턴을 감지한다. ~30 LOC.

```typescript
/** 도구 루프 감지기 */
interface ToolCallTracker {
  readonly name: string;
  readonly timestamps: number[];
}

const LOOP_THRESHOLD = 5; // 동일 도구 연속 호출 횟수
const LOOP_WINDOW_MS = 10_000; // 감지 윈도우 (10초)

function isToolLoop(tracker: ToolCallTracker): boolean {
  const recent = tracker.timestamps.filter((t) => Date.now() - t < LOOP_WINDOW_MS);
  return recent.length >= LOOP_THRESHOLD;
}
// 감지 시 → 'require-approval' 강제 + 이벤트 발행
```

### 13.3 TypeScript 패턴

구현 시 다음 패턴을 적극 활용할 것:

- **`satisfies`**: 타입 추론을 유지하면서 타입 검증 (`BUILT_IN_GROUPS satisfies readonly ToolGroup[]`)
- **exhaustive switch**: `default: never` 패턴으로 누락 분기 컴파일 타임 검출

```typescript
function handleVerdict(v: PolicyVerdict): string {
  switch (v) {
    case 'allow':
      return 'allowed';
    case 'deny':
      return 'denied';
    case 'require-approval':
      return 'pending';
    default:
      return v satisfies never;
  }
}
```

### 13.4 OpenClaw 참조 경로 보정

§2의 OpenClaw 참조 경로는 분석 시점의 스냅샷 기준이다. 실제 구현 시 경로가 존재하지 않으면 패턴만 참조하고 경로를 무시할 것. 핵심 패턴은 이미 본 plan에 추출되어 있다.
