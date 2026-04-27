# Phase 25 — 프롬프트·페르소나 외부화 (Prompt Externalization)

## Context

Phase 24 에서 모델 역할 라우팅이 붙으면 동일 사용자 요청이 모델별로 다른 진입점을 거치게 된다. 이 시점에 프롬프트·페르소나가 코드 안에 분산된 채로 남으면 다음 문제가 가시화된다.

1. **페르소나 분산** — 코드베이스에 페르소나 정의가 **5곳**에 흩어져 있다.
   - `packages/server/src/main.ts:81-103` `DEFAULT_SYSTEM_PROMPT` (한국어, 사용 중)
   - `packages/server/src/gateway/rpc/methods/agent.ts:36-42` `AGENTS` 메타 (한국어, `agent.list` 응답에 사용 중)
   - `packages/skills-finance/src/news/analysis/market-analysis.ts:65-88` `buildAnalysisSystemPrompt` (영어, `analyze_market` 내부 LLM 호출에 사용 중)
   - `packages/skills-finance/src/news/analysis/sentiment.ts:127` 인라인 system 한 줄 (영어, sentiment 분석 내부 LLM 호출에 사용 중)
   - `packages/agent/src/agents/system-prompt.ts:46-58` `buildIdentitySection` + L298 `buildSystemPrompt` 15+ 섹션 동적 빌더 (영어, **호출 0건**, `index.ts:142` re-export 만 존재 — 죽은 코드)

   "FinClaw" 이름·역할·원칙 변경 시 4-5곳 동기화 필요.

2. **프롬프트가 코드에 박혀 변경 비용 높음** — 23줄 자연어가 TS 문자열 배열(`['...', '', '...'].join('\n')`)에 갇혀 있다. diff 노이즈, 빌드 재실행, 마크다운·인용 처리 어색, 비기술자 수정 불가.

3. **변형 분기가 코드 안에 있음** — `buildAnalysisSystemPrompt(depth, language)` 가 depth(brief/standard/detailed) × language(ko/en) = 6 변형을 함수 안 if-else 로 조립. 변형 추가 시 함수 안 분기 폭발.

4. **회귀 테스트 0개** — 시스템 프롬프트 / 분석 프롬프트가 바뀌어도 감지 못함. Phase 24 라우팅이 들어가면 모델 × 프롬프트 조합이 늘어 회귀 위험 ↑.

본 Phase 의 목표는 **모든 자연어 instruction 을 `.md` 파일로 외부화**하고, **단일 페르소나 진실** 을 확립하며, **회귀 방지 골든 파일 테스트** 를 도입하는 것. 신규 기능 추가 없음. 기존 인라인 문자열을 외부 파일로 옮기고 단일 진실 1개를 확립한다.

**사용자 결정 사항** (2026-04-25 Q&A):

- **언어로 통일하지 않는다** — 페르소나의 본질(이름·역할·5대 원칙)만 통일하고, 표현 언어는 호출 site 의 출력 대상에 따라 결정. 외부 진입(=사용자 응답)은 한국어, 내부 LLM 호출(=구조화 JSON)은 영어 유지.
- **`.md` 위치는 패키지별 분리** — 모노레포 정합성 + 도구별 응집도 우선. `packages/server/prompts/` 와 `packages/skills-finance/prompts/`.
- **depth × language 분기는 파일 6개** — frontmatter 변수보다 파일 분리가 단순.
- **`system-prompt.ts` 동적 빌더는 삭제 기본** — git log 확인 결과 `00060e5 feat(agent): ... and system prompt` 커밋에서 도입됐으나 채택되지 않음 (정적 상수가 대신 채택됨). 호출 0건 = 죽은 코드. 본 phase 에서 정리.
- **추측성 기능 도입 금지** — hot-reload, A/B 테스트, 버전 관리, 자동 다국어 감지는 범위 외.

**전수 조사 결과** (2026-04-27, `feature/prompt-externalization` 브랜치 시점):

- 위 5곳 외에 자연어 instruction 1곳 추가 식별 — `packages/skills-finance/src/news/analysis/market-analysis.ts:124-140` `buildAnalysisUserPrompt` (영어 6 줄 + 조건부 분기 2개).
- TUI/Web 클라이언트는 `agent.list` RPC 응답을 그대로 소비 — 페르소나 텍스트가 박힌 곳 없음. 단일 진실 깨질 위험 없음.
- `packages/server/src/auto-reply/stages/deliver.ts:34` 면책 disclaimer 는 사용자 직접 출력 정적 텍스트(LLM 프롬프트 아님). 본 phase 범위 외.

---

## 밀스톤 A — 페르소나 통합 & 외부화

### 목표

이름·역할·5대 원칙을 단일 `.md` 로 외부화. 외부 진입 시스템 프롬프트와 `agent.list` 메타가 같은 파일을 읽게 한다. 죽은 코드 정리.

### 전제

- `packages/server/src/main.ts:81-103` 정적 `DEFAULT_SYSTEM_PROMPT` 가 모든 외부 진입(chat.send / agent.run / auto-reply / TUI / Web)에서 사용 중.
- `packages/server/src/gateway/rpc/methods/agent.ts:36-42` `AGENTS` 메타가 `agent.list` 응답으로 사용자 UI 카드에 노출.
- `packages/agent/src/agents/system-prompt.ts` 의 `buildSystemPrompt` 와 14개 섹션 빌더는 호출 site 0건 (`index.ts:142` re-export 만).

### 작업

**파일**:

- `packages/server/prompts/finclaw.identity.md` (신설, ~25 줄 — 페르소나 본질 + frontmatter)
- `packages/server/prompts/finclaw.system.ko.md` (신설, ~30 줄 — 외부 진입용, identity 인용 + 한국어 가이드)
- `packages/server/src/prompts/loader.ts` (신설, ~50 LOC — frontmatter 파서 + 본문 로더)
- `packages/server/src/main.ts` (수정, ~20 LOC — `DEFAULT_SYSTEM_PROMPT` 제거, `.md` 로드)
- `packages/server/src/gateway/rpc/methods/agent.ts` (수정, ~15 LOC — `AGENTS` 의 `name`/`description` 을 `finclaw.identity.md` frontmatter 에서 읽기)
- `packages/agent/src/agents/system-prompt.ts` (삭제)
- `packages/agent/src/agents/__tests__/system-prompt.test.ts` (삭제, 있다면)
- `packages/agent/src/index.ts` (수정, line 142 re-export 제거)
- `packages/server/package.json` (수정, `files` 에 `prompts/**/*.md` 포함)

**`finclaw.identity.md` 형식**:

```markdown
---
id: finclaw-partner
name: FinClaw Personal Finance Partner
description: 개인 금융 파트너. 시세 조회·뉴스·포트폴리오·알림 관리.
version: 1.0
---

## 정체성

너는 사용자의 **개인 금융 파트너(Personal Finance Partner)** FinClaw다.

## 역할

- 시장 데이터 조회, 뉴스 요약, 포트폴리오 추적, 가격 알림 관리가 주 업무다.
- 사용자 본인의 돈이 걸린 판단을 보조한다. 신중하고 정직하게 답하라.

## 원칙

1. **읽기 전용.** 매매 실행·자금 이체·계좌 변경은 절대 제안하지 않는다.
2. **환각 금지.** 수치·뉴스·날짜는 반드시 도구로 확인하고 답한다.
3. **출처 명시.** 수치 언급 시 어느 API·어느 시각 데이터인지 밝혀라.
4. **불확실성 수치화.** 예측·전망은 숫자(범위, 확률, 신뢰도)로 표현한다.
5. **간결한 한국어.** 불필요한 인사·군더더기 없이 핵심부터.
```

`finclaw.system.ko.md` 는 identity 본문을 인용(또는 빌드 시 결합) + 도구 목록·언어 가이드.

**로더 형태** (의존성 추가 없음):

```ts
// packages/server/src/prompts/loader.ts
export interface PromptDocument {
  readonly frontmatter: Record<string, string>;
  readonly body: string;
}

export async function loadPrompt(filename: string): Promise<PromptDocument> {
  const raw = await readFile(resolve(PROMPTS_DIR, filename), 'utf-8');
  return parsePrompt(raw); // --- frontmatter --- 분리
}
```

frontmatter 는 단순 `key: value` 라인 파서 (YAML 라이브러리 안 씀 — 의존성 회피).

### 검증

- 기동 시 로드된 시스템 프롬프트 == 기존 `DEFAULT_SYSTEM_PROMPT` 문자열과 동일 (회귀 보존)
- `agent.list` 응답의 `name`/`description` == `finclaw.identity.md` frontmatter
- `system-prompt.ts` 와 관련 export 완전 삭제, `pnpm typecheck` 통과
- `prompts/finclaw.identity.md` 파일 누락 시 기동 실패 + 에러 메시지에 다음 3가지 포함:
  1. 검색한 디렉토리의 절대 경로
  2. 누락된 파일명 (또는 frontmatter 키 누락 시 키 이름)
  3. 어느 호출 site 가 요구했는지 (예: `loadPrompt` 호출 위치)

---

## 밀스톤 B — 스킬 내부 LLM 프롬프트 외부화

### 목표

`analyze_market` 의 6 변형 시스템 프롬프트와 `sentiment` 의 시스템 프롬프트를 `.md` 파일로 외부화.

### 전제

- `analyze_market`: depth(brief/standard/detailed) × language(ko/en) = 6 변형. 현재 `market-analysis.ts:65-88` 함수 안 if-else.
- `sentiment`: 한 줄 system + rule-hint 점수 동적 주입 (`sentiment.ts:127`). 점수만 `{{ruleHint}}` 변수 치환.
- 응답 검증(`AnalysisResponseSchema`, `LlmSentimentSchema`) 은 코드에 남긴다 (Zod, 타입 안전성).
- **모델 ID 통일은 Phase 24 책임** — 본 phase 는 프롬프트만 다룸. (Phase 24 plan 의 호출 지점 표에 스킬 내부 LLM 호출 추가 항목과 짝.)
- **`buildAnalysisUserPrompt` 는 코드에 유지** — `${newsDigest}` 임베딩 + `symbols`/`includeIndicators` 조건부 분기가 본질이라 단순 `{{key}}` 치환으로 표현 시 가독성 더 나빠짐. 자연어 비중도 system 대비 낮음(고정 라벨 3개). system 외부화만으로 변경 빈도 높은 자연어는 충분히 분리됨.

### 작업

**파일**:

- `packages/skills-finance/prompts/news/analyze.brief.ko.md` (신설)
- `packages/skills-finance/prompts/news/analyze.brief.en.md` (신설)
- `packages/skills-finance/prompts/news/analyze.standard.ko.md` (신설)
- `packages/skills-finance/prompts/news/analyze.standard.en.md` (신설)
- `packages/skills-finance/prompts/news/analyze.detailed.ko.md` (신설)
- `packages/skills-finance/prompts/news/analyze.detailed.en.md` (신설)
- `packages/skills-finance/prompts/news/sentiment.system.md` (신설, `{{ruleHint}}` 변수 1개)
- `packages/skills-finance/src/news/analysis/prompt-loader.ts` (신설, ~40 LOC)
- `packages/skills-finance/src/news/analysis/market-analysis.ts` (수정, ~30 LOC — `buildAnalysisSystemPrompt` 함수 제거 → `loadAnalysisPrompt` 호출)
- `packages/skills-finance/src/news/analysis/sentiment.ts` (수정, ~15 LOC)
- `packages/skills-finance/package.json` (수정, `files` 에 `prompts/**/*.md`)

**로더 형태**:

```ts
// packages/skills-finance/src/news/analysis/prompt-loader.ts
const PROMPTS_DIR = resolve(fileURLToPath(import.meta.url), '../../../../prompts/news');

export async function loadAnalysisPrompt(
  depth: 'brief' | 'standard' | 'detailed',
  language: 'ko' | 'en',
): Promise<string> {
  return readFile(resolve(PROMPTS_DIR, `analyze.${depth}.${language}.md`), 'utf-8');
}

export async function loadSentimentPrompt(ruleHint: number): Promise<string> {
  const tpl = await readFile(resolve(PROMPTS_DIR, 'sentiment.system.md'), 'utf-8');
  return tpl.replaceAll('{{ruleHint}}', ruleHint.toFixed(2));
}
```

**변수 치환 정책**: 단순 `{{key}}` → 값 치환만. 조건문/반복문 없음. 필요해지면 그때 라이브러리.

**`analyze.standard.ko.md` 예시**:

```markdown
You are a professional financial market analyst. Analyze the provided news articles and generate a market analysis report.
한국어로 분석 결과를 작성하세요.
Provide a balanced, moderate-length analysis.

Response format (strict JSON, no markdown):
{
"summary": "시장 전망 요약",
"sentiment": { "score": -1.0~1.0, "label": "very_negative|negative|neutral|positive|very_positive", "confidence": 0.0~1.0 },
"keyFactors": ["핵심 요인 1", "핵심 요인 2"],
"risks": ["리스크 1"],
"opportunities": ["기회 1"]
}
```

### 검증

- 6 변형 × 동일 입력 → 응답 Zod 검증 통과 (mock LLM 응답 기반)
- 파일 누락 → 친절한 에러 (어떤 depth/language 조합이 누락됐는지)
- `buildAnalysisSystemPrompt` / `buildAnalysisUserPrompt` 함수 완전 삭제, 호출 site 0
- `sentiment.ts` 의 인라인 system 문자열 완전 삭제

---

## 밀스톤 C — 골든 파일 테스트 & 빌드 검증

### 목표

프롬프트 변경 시 의도하지 않은 회귀 감지. 빌드 시 `.md` 누락 검출. 변경 시 명시적 승인 워크플로 도입.

### 전제

- vitest 4-tier 구조 (`docs/00-prerequisites/testing-strategy.md`).
- 현재 시스템 프롬프트 회귀 테스트 0개.

### 작업

**파일**:

- `packages/server/src/prompts/__tests__/loader.test.ts` (신설, ~50 LOC)
- `packages/server/src/prompts/__tests__/identity.test.ts` (신설, ~40 LOC — 골든 파일)
- `packages/skills-finance/src/news/analysis/__tests__/prompt-loader.test.ts` (신설, ~80 LOC)
- `packages/skills-finance/src/news/analysis/__tests__/analyze-prompts.test.ts` (신설, ~100 LOC — 6 변형 × Zod 검증)

**테스트 항목**:

- `finclaw.identity.md` frontmatter 가 `agent.list` 응답과 일치
- `finclaw.system.ko.md` 가 키워드 포함: "FinClaw" / "읽기 전용" / "환각 금지" / "출처 명시" (스냅샷, 변경 시 `vitest -u` 명시 승인 필요)
- 6 변형 `analyze.*.md` 모두 로드 가능 + 각 변형이 `AnalysisResponseSchema` 검증 통과 응답을 유도 (mock 또는 실제 LLM — live tier)
- `sentiment.system.md` 의 `{{ruleHint}}` 치환 결과 형식 정확 (`0.42` 같은 소수점 2자리)
- 누락 파일 시 로더가 명확한 에러 throw

**빌드 검증**:

- `package.json#files` 에 `prompts/**/*.md` 포함 → `pnpm pack` 결과물에 포함되는지 확인
- ESM `import.meta.url` 기반 경로 해석이 dist 빌드 후에도 작동하는지 확인 (필요 시 `tsconfig.json` 의 `outDir` 와 `prompts/` 상대 경로 검증)

**CI 가드** (회귀 자동 차단):

- `package.json#files` 에 `prompts/**/*.md` 가 누락된 경우 실패하는 테스트 추가 (해당 패키지 `package.json` 직접 파싱)
- `pnpm pack --pack-destination /tmp/finclaw-pack-check` 로 tarball 생성 후 안에 `prompts/*.md` 가 포함되는지 검증하는 스크립트를 CI 스텝에 추가
- 두 가드 모두 server / skills-finance 두 패키지 각각 검증

### 검증

- `pnpm test` 통과
- `prompts/` 안 임의 파일 1개 삭제 시 관련 테스트 실패
- `pnpm build && node dist/main.js` 기동 시 프롬프트 정상 로드

---

## 밀스톤 D — 분석 프롬프트 강화 (2026-04-27 추가)

### 목표

밀스톤 B 가 단순 외부화에 그쳐 분석 프롬프트가 페르소나 5대 원칙(특히 출처 명시·환각 금지·불확실성 수치화)을 전혀 반영 못함. 외부화로 인해 손쉬운 보강이 가능해진 시점에 **분석 출력의 감사 가능성**을 확보한다. 본 phase 의 "단일 진실" 목표는 페르소나 텍스트뿐 아니라 페르소나 원칙이 모든 LLM 호출에 반영되어야 완성됨.

### 전제

- 밀스톤 A·B·C 완료 후 진행 (외부화·테스트 인프라 활용).
- 6 변형 `.md` 의 본문이 더 이상 함수 출력과 byte-equal 이지 않게 됨 — 외부화 완료 시점부터 무관하므로 OK.
- `MarketAnalysis` 타입 변경의 downstream blast radius 확인 결과:
  - `tools.ts:170` 가 `JSON.stringify(analysis)` 로 LLM 에 그대로 전달 → 신규 필드 자동 활용
  - `embeds.ts` 는 `NewsItem.sentiment` (별 타입) 사용 → 무관
  - 직접 코드 호출자 없음
- **사용자 결정** (2026-04-27): Lv.2 (스키마 확장 포함) 채택. Lv.3 (도메인 특화) 은 별 phase.

### 작업

**파일**:

- `packages/skills-finance/src/news/types.ts` (수정, ~30 LOC) — `MarketAnalysis` 확장 + 보조 타입 신설
- `packages/skills-finance/src/news/analysis/market-analysis.ts` (수정, ~30 LOC) — `AnalysisResponseSchema` Zod 갱신
- `packages/skills-finance/prompts/news/analyze.{depth}.{lang}.md` × 6 (재작성, ~40-60 줄/파일)
- `packages/skills-finance/src/news/analysis/__tests__/analyze-prompts.test.ts` (수정) — 신규 schema 검증

**`MarketAnalysis` 새 형태**:

```ts
export type RiskCategory = 'regulatory' | 'market' | 'company' | 'macro';
export type Probability = 'low' | 'medium' | 'high';
export type Impact = 'high' | 'medium' | 'low';
export type TimeHorizon = 'short_term' | 'medium_term' | 'long_term';

export interface AnalysisFactor {
  readonly factor: string;
  readonly impact: Impact;
  readonly evidence: readonly number[]; // 인용한 기사 번호 (1-indexed)
}
export interface AnalysisRisk {
  readonly risk: string;
  readonly category: RiskCategory;
  readonly probability: Probability;
  readonly evidence: readonly number[];
}
export interface AnalysisOpportunity {
  readonly opportunity: string;
  readonly impact: Impact;
  readonly evidence: readonly number[];
}
export interface AnalysisSentiment {
  readonly score: number;
  readonly label: NewsSentiment['label'];
  readonly confidence: number;
  readonly rationale: string; // 1-2 문장
  readonly evidence: readonly number[];
}
export interface MarketAnalysis {
  readonly summary: string;
  readonly summaryEvidence: readonly number[];
  readonly sentiment: AnalysisSentiment;
  readonly keyFactors: readonly AnalysisFactor[];
  readonly risks: readonly AnalysisRisk[];
  readonly opportunities: readonly AnalysisOpportunity[];
  readonly timeHorizon: TimeHorizon;
  readonly dataGaps: readonly string[]; // 부족한 정보 영역 자기보고
  readonly analyzedAt: Date;
  readonly newsCount: number;
  readonly symbols: readonly TickerSymbol[];
}
```

**6 `.md` 공통 헤더 (페르소나 5대 원칙 압축)**:

```
You are FinClaw's market analyst. You operate under these principles:
1. CITE EVERY CLAIM. Reference article numbers like [1], [3] in evidence arrays. If a claim has no article support, do not include it.
2. NO HALLUCINATION. If insufficient news to support a field, return an empty array or "data_insufficient" in dataGaps.
3. QUANTIFY UNCERTAINTY. Use confidence scores (0.0-1.0) and explicit probability labels (low/medium/high), not vague language.
4. SCOPE STRICTLY READ-ONLY. Do not recommend buy/sell actions; describe market state and factors only.
5. CONCISE. No greetings, no preamble. Output JSON only.

[depth/language directives]

Response format (strict JSON, no markdown):
{ ...새 schema... }
```

### 검증

- `pnpm typecheck` / `pnpm lint` / `pnpm test` 통과
- `analyze-prompts.test.ts` 가 신규 7 필드 (summary, summaryEvidence, sentiment, keyFactors, risks, opportunities, timeHorizon, dataGaps) 모두 명세 확인
- mock 응답이 신규 Zod 스키마 통과
- 6 변형 모두 페르소나 5대 원칙 헤더 포함 (substring check)
- `bash scripts/verify-pack-includes-prompts.sh` 통과 (파일 수 동일)

---

## 완료 조건 (Phase 25 Done When)

- 밀스톤 A/B/C/D 전부 완료.
- 페르소나 정의 위치 **5곳 → 2곳** 으로 축소 (`finclaw.identity.md` + `finclaw.system.ko.md`).
- `system-prompt.ts` 와 14개 섹션 빌더 export 완전 삭제, `pnpm typecheck` 통과.
- `analyze_market` 6 변형 + `sentiment` 모두 `.md` 로드, 인라인 함수 제거.
- 분석 프롬프트가 페르소나 5대 원칙 헤더 + citation 의무 + 구조화 응답 스키마 포함 (밀스톤 D).
- 골든 파일 테스트 8+ 케이스 통과.
- `tsgo --noEmit`, `pnpm lint`, `pnpm test` 통과.
- 실제 시나리오 3개 수동 검증:
  1. "AAPL 뉴스 분석해줘" → 외부 한국어 응답 + 내부 영어 분석 프롬프트 정상 적용
  2. `agent.list` → frontmatter 와 동일한 `name`/`description` 반환
  3. `prompts/finclaw.identity.md` 임의 수정 → 재기동 후 즉시 반영 (hot-reload 아님, 재기동 필요)

---

## 범위 외 (Phase 26 이후)

- **프롬프트 hot-reload** — dev 모드에서 `.md` 변경 시 재시작 없이 반영. 추측성, 필요해지면 추가.
- **프롬프트 A/B 테스트 인프라** — 같은 입력 두 변형에 보내고 결과 비교. 측정 인프라 비용 > 차이.
- **프롬프트 버전 관리** — frontmatter `version` 자동 변경 추적. git 으로 충분.
- **`system-prompt.ts` 동적 빌더 부활** — 15+ 섹션 빌더를 정적 `.md` 위에 얹는 작업. 본 phase 는 삭제, 부활은 별 phase.
- **다국어 자동 분기** — 사용자 발화 언어 감지 → 자동 `language` 결정. 현재는 호출 site 명시.
- **임베딩 파일명 정리** — `packages/storage/src/embeddings/anthropic.ts` 가 실제로는 Voyage AI 호출. 파일명 `voyage.ts` 로 변경. 인지 부담 해소 작업으로 별 phase.
- **사용자 정의 프롬프트** — 사용자가 자신의 페르소나·원칙을 추가/덮어쓸 수 있는 config 인터페이스. Phase 24 의 `customInstructions` 와 통합 검토.
- **`buildAnalysisUserPrompt` 외부화** — 동적 임베딩(`${newsDigest}`) + 조건부 분기 본질이라 단순 치환으론 표현 못 함. 외부화하면 가독성 더 나빠짐. 향후 user 프롬프트 변형이 폭발하면 그때 별 phase 에서 템플릿 엔진 도입 여부와 함께 재검토.
- **UI 정적 텍스트 외부화** — `auto-reply/stages/deliver.ts:34` 면책 disclaimer, 도구 description, 에러 문구 등. 페르소나 원칙과 의미상 연결되지만 LLM 프롬프트가 아니라 사용자 직접 출력. `prompts/` 와 다른 위치(`messages/` 또는 i18n 인프라)가 적합. 별 phase.

---

## 오픈 질문 (Phase 25 진행 중 확정)

1. **`system-prompt.ts` 처리 최종 결정** — 본 plan 기본 = 삭제. 단, `buildIdentitySection`/`buildToolsSection` 등 잘 만들어진 섹션 빌더가 향후 동적 프롬프트에 재사용 가치가 있다면 보류 검토. git blame 확인 결과 `00060e5` 에서 도입 후 미채택. **답: 삭제.** 부활 필요 시 별 phase 에서 처음부터 재설계.
2. **frontmatter 파서 자체 구현 vs YAML 라이브러리** — 본 plan 기본 = 자체 구현 (`key: value` 단순 라인). 현재 frontmatter 가 4-5 키만 쓰므로 라이브러리 의존성 추가 비용 > 이득.
3. **`prompts/` 위치 확정** — 본 plan 기본 = 패키지별 분리 (`packages/server/prompts/`, `packages/skills-finance/prompts/`). root `prompts/` 단일 디렉토리는 모노레포 패키지 응집도 깨짐.
4. **Phase 24 와의 경계 명시** — 스킬 내부 LLM 호출(`analyze_market`/`sentiment`) 의 모델 ID 구버전 통일(`claude-sonnet-4-20250514` → `claude-sonnet-4-6`)과 라우터 배선은 **Phase 24** 책임. 본 phase 는 **프롬프트 외부화** 만 담당. Phase 24 plan 밀스톤 C 호출 지점 표에 "스킬 내부 LLM 호출" 항목 추가 필요 (별도 메모로 처리).
5. **변수 치환 범위** — `{{ruleHint}}` 외에 다른 동적 변수가 필요한가? 현재 코드 스캔 결과 `sentiment` 의 rule hint 1개만. 본 phase 에서는 1개만 지원. 추가 변수 등장 시 그때 확장.
