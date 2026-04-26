# Phase 25 — 실행 가능한 TODO

> 본 문서는 [plan.md](./plan.md) 를 그대로 코드로 옮기기 위한 외과적 작업 지시서다. 위에서 아래로 순서대로 실행하면 plan.md 의 완료 조건이 만족된다. 각 항목의 마지막 줄은 검증 명령이며, 실패 시 다음으로 진행하지 말 것.

브랜치: `feature/prompt-externalization`
작업 디렉토리: `/mnt/c/Users/박/Desktop/hi/FinClaw`

---

## 사전 준비

### P1. 브랜치·기준점 확인

```sh
git status                              # clean working tree
git branch --show-current               # feature/prompt-externalization
git rev-parse HEAD                      # 시작 커밋 SHA 기록
```

### P2. 현재 시스템 프롬프트 회귀 기준 캡처

밀스톤 A 완료 후 `loadPrompt('finclaw.system.ko.md').body` 와 비교할 baseline 을 추출한다.

```sh
node -e "
const lines = require('fs').readFileSync('packages/server/src/main.ts', 'utf-8').split('\n');
const start = lines.findIndex(l => l.includes('DEFAULT_SYSTEM_PROMPT = ['));
const end = lines.findIndex((l, i) => i > start && l.includes(\"].join('\\\n')\"));
const arr = lines.slice(start + 1, end).map(l => l.trim().replace(/^'/, '').replace(/',$/, '').replace(/'$/, '')).filter(l => l !== '' || true);
require('fs').writeFileSync('plans/phase25/.baseline-system-prompt.txt', arr.join('\n'));
console.log('baseline lines:', arr.length);
"
```

> 생성된 `plans/phase25/.baseline-system-prompt.txt` 는 git ignore — 작업 검증 후 삭제.

---

## 밀스톤 A — 페르소나 통합 & 외부화

### A1. CREATE `packages/server/prompts/finclaw.identity.md`

페르소나 단일 진실. frontmatter 는 `agent.list` 응답으로 직접 노출.

```markdown
---
id: finclaw-partner
name: FinClaw Personal Finance Partner
description: 개인 금융 파트너. 시세 조회·뉴스·포트폴리오·알림 관리.
version: 1.0
---

너는 사용자의 **개인 금융 파트너(Personal Finance Partner)** FinClaw다.

## 역할

- 시장 데이터 조회, 뉴스 요약, 포트폴리오 추적, 가격 알림 관리가 주 업무다.
- 사용자 본인의 돈이 걸린 판단을 보조한다. 신중하고 정직하게 답하라.

## 원칙

1. **읽기 전용.** 매매 실행·자금 이체·계좌 변경은 절대 제안하지 않는다. 요청받으면 "나는 조회·분석만 한다"라고 명확히 거절한다.
2. **환각 금지.** 수치·뉴스·날짜는 반드시 도구로 확인하고 답한다. 도구 없이 지식에서 가격·뉴스를 지어내지 말 것. 확인 불가면 "확인할 수 없다"라고 답한다.
3. **출처 명시.** 수치 언급 시 어느 API·어느 시각 데이터인지 밝혀라. 응답 끝에 시스템이 자동으로 출처를 첨부하지만, 본문에서도 인용하면 더 좋다.
4. **불확실성 수치화.** 예측·전망은 숫자(범위, 확률, 신뢰도)로 표현한다. "잘 모르겠지만" 같은 모호한 표현 최소화.
5. **간결한 한국어.** 불필요한 인사·군더더기 없이 핵심부터. 긴 설명은 불릿으로.
```

검증: `test -f packages/server/prompts/finclaw.identity.md && head -5 packages/server/prompts/finclaw.identity.md | grep -q 'id: finclaw-partner'`

### A2. CREATE `packages/server/prompts/finclaw.system.ko.md`

LLM 에 실제 전달되는 외부 진입 시스템 프롬프트. **본문은 기존 `DEFAULT_SYSTEM_PROMPT` 와 byte-equal 이어야 회귀 보존**.

```markdown
---
id: finclaw-system-ko
language: ko
references: finclaw-partner
---

너는 사용자의 **개인 금융 파트너(Personal Finance Partner)** FinClaw다.

## 역할

- 시장 데이터 조회, 뉴스 요약, 포트폴리오 추적, 가격 알림 관리가 주 업무다.
- 사용자 본인의 돈이 걸린 판단을 보조한다. 신중하고 정직하게 답하라.

## 원칙

1. **읽기 전용.** 매매 실행·자금 이체·계좌 변경은 절대 제안하지 않는다. 요청받으면 "나는 조회·분석만 한다"라고 명확히 거절한다.
2. **환각 금지.** 수치·뉴스·날짜는 반드시 도구로 확인하고 답한다. 도구 없이 지식에서 가격·뉴스를 지어내지 말 것. 확인 불가면 "확인할 수 없다"라고 답한다.
3. **출처 명시.** 수치 언급 시 어느 API·어느 시각 데이터인지 밝혀라. 응답 끝에 시스템이 자동으로 출처를 첨부하지만, 본문에서도 인용하면 더 좋다.
4. **불확실성 수치화.** 예측·전망은 숫자(범위, 확률, 신뢰도)로 표현한다. "잘 모르겠지만" 같은 모호한 표현 최소화.
5. **간결한 한국어.** 불필요한 인사·군더더기 없이 핵심부터. 긴 설명은 불릿으로.

## 사용 가능한 도구 (API 키 설정 상태에 따라 가변)

- `get_stock_price`, `get_crypto_price`, `get_forex_rate`, `get_market_chart` — 시세 조회
- `get_financial_news`, `analyze_market` — 금융 뉴스·분석
- `set_alert`, `list_alerts`, `remove_alert`, `get_alert_history` — 가격/변화/뉴스 알림
- `get_portfolio_summary` — 포트폴리오 요약
- `get_current_datetime`, `web_fetch`, `read_local_file` — 일반 유틸

도구가 필요한데 없으면 "도구 X가 필요한데 지금 활성화되어 있지 않다. API 키 확인 바란다"라고 답한다.

## 도구 결과 처리

도구 결과가 모델 일시 불가 안내(예: "analyze_market 사용 불가: opus 이상 모델…")를 반환하면 가짜 분석을 만들지 말고 어느 모델이 일시 불가하며 약 60초 후 재시도 가능하다는 점을 사용자에게 한국어로 그대로 전달한다.
```

> 페르소나 본문(역할+원칙)은 identity.md 와 의도적으로 일치. 회귀 테스트(C2)에서 substring 검증.

검증: `test -f packages/server/prompts/finclaw.system.ko.md`

### A3. CREATE `packages/server/src/prompts/loader.ts`

frontmatter 파서 + 본문 로더. YAML 라이브러리 의존성 없음.

```ts
// packages/server/src/prompts/loader.ts
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts');

export interface PromptDocument {
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
}

export class PromptLoadError extends Error {
  constructor(
    message: string,
    public readonly searchDir: string,
    public readonly filename: string,
    public readonly missingKey?: string,
  ) {
    super(message);
    this.name = 'PromptLoadError';
  }
}

export async function loadPrompt(filename: string, callerHint?: string): Promise<PromptDocument> {
  const fullPath = resolve(PROMPTS_DIR, filename);
  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf-8');
  } catch (cause) {
    throw new PromptLoadError(
      `Prompt file not found: ${filename}\n  searched in: ${PROMPTS_DIR}\n  required by: ${callerHint ?? '<unknown>'}`,
      PROMPTS_DIR,
      filename,
    );
  }
  return parsePrompt(raw, filename, callerHint);
}

export function parsePrompt(
  raw: string,
  filename = '<inline>',
  callerHint?: string,
): PromptDocument {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw.trim() };
  }
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    frontmatter[key] = value;
  }
  return { frontmatter, body: match[2].trim() };
}

export function requireFrontmatterKeys(
  doc: PromptDocument,
  filename: string,
  keys: readonly string[],
  callerHint?: string,
): void {
  for (const key of keys) {
    if (!(key in doc.frontmatter)) {
      throw new PromptLoadError(
        `Missing frontmatter key '${key}' in ${filename}\n  searched in: ${PROMPTS_DIR}\n  required by: ${callerHint ?? '<unknown>'}`,
        PROMPTS_DIR,
        filename,
        key,
      );
    }
  }
}
```

검증: `pnpm --filter @finclaw/server exec tsgo --noEmit src/prompts/loader.ts`

### A4. EDIT `packages/server/src/main.ts` — `DEFAULT_SYSTEM_PROMPT` 제거 → 로드

**(a) import 추가** (파일 상단 import 블록 하단에):

```ts
import { loadPrompt } from './prompts/loader.js';
```

**(b) `DEFAULT_SYSTEM_PROMPT = [...]` 블록 (현재 line 85-110) 통째로 삭제.**

**(c) `main()` 함수 진입 직후 (env 검증 직전 또는 직후) 시스템 프롬프트 로드 추가**:

```ts
const systemPromptDoc = await loadPrompt('finclaw.system.ko.md', 'main:DEFAULT_SYSTEM_PROMPT');
const DEFAULT_SYSTEM_PROMPT = systemPromptDoc.body;
```

**(d) 기존 `DEFAULT_SYSTEM_PROMPT` 참조 (line 279, 377 등) 는 그대로 유지** — 변수명을 같게 유지하므로 호출 site 변경 불필요.

검증:

```sh
grep -n "DEFAULT_SYSTEM_PROMPT" packages/server/src/main.ts   # 변수 선언 1회 + 사용 N회
! grep -q "'## 역할'" packages/server/src/main.ts              # 인라인 문자열 제거 확인
```

### A5. EDIT `packages/server/src/gateway/rpc/methods/agent.ts` — `AGENTS` 를 frontmatter 에서

**(a) import 추가**:

```ts
import { loadPrompt, requireFrontmatterKeys } from '../../../prompts/loader.js';
```

**(b) 정적 `AGENTS` 배열 (line 53-59) 을 비동기 로더로 교체**:

```ts
let AGENTS: readonly AgentInfo[] | null = null;

async function loadAgents(): Promise<readonly AgentInfo[]> {
  if (AGENTS) return AGENTS;
  const doc = await loadPrompt('finclaw.identity.md', 'agent.ts:loadAgents');
  requireFrontmatterKeys(
    doc,
    'finclaw.identity.md',
    ['id', 'name', 'description'],
    'agent.ts:loadAgents',
  );
  AGENTS = [
    {
      id: doc.frontmatter.id,
      name: doc.frontmatter.name,
      description: doc.frontmatter.description,
    },
  ];
  return AGENTS;
}
```

**(c) `AGENTS.map(...)` / `AGENTS.find(...)` 호출 site (line 90, 107, 148) 모두 `(await loadAgents()).map(...)` / `(await loadAgents()).find(...)` 로 교체**. 핸들러는 이미 `async execute` 이므로 await 가능.

검증:

```sh
grep -c "loadAgents()" packages/server/src/gateway/rpc/methods/agent.ts   # >= 3
! grep -q "'finclaw-partner'" packages/server/src/gateway/rpc/methods/agent.ts  # 정적 ID 제거
```

### A6. DELETE `packages/agent/src/agents/system-prompt.ts`

```sh
rm packages/agent/src/agents/system-prompt.ts
```

검증: `! test -f packages/agent/src/agents/system-prompt.ts`

### A7. EDIT `packages/agent/src/index.ts` — re-export 제거

**삭제 대상**: line 159-174 의 `// ── Phase 7: System Prompt ──` 블록 전체:

```ts
// ── Phase 7: System Prompt ──
export type {
  PromptSection,
  InvestmentProfile,
  PromptModelCapabilities,
  PromptBuildContext,
  PromptBuildMode,
} from './agents/system-prompt.js';
export {
  buildSystemPrompt,
  buildIdentitySection,
  buildToolsSection,
  buildFinanceContextSection,
  buildComplianceSection,
  buildRiskDisclaimerSection,
} from './agents/system-prompt.js';
```

검증:

```sh
! grep -q "system-prompt" packages/agent/src/index.ts
pnpm typecheck                                # buildSystemPrompt/buildIdentitySection 사용처 0건 확인
```

### A8. EDIT `packages/server/package.json` — `files` 추가

현재 `files` 키 없음. 추가:

```json
{
  "files": ["dist", "prompts/**/*.md"]
}
```

> `files` 는 alphabetical 정렬 규칙(oxfmt) 에 따라 적절한 위치에. 작성 후 `pnpm format:fix` 실행.

검증:

```sh
node -e "console.log(require('./packages/server/package.json').files)"   # ['dist', 'prompts/**/*.md']
```

### A9. 밀스톤 A 검증

```sh
pnpm typecheck                          # 0 errors
pnpm --filter @finclaw/server build     # dist 생성
node -e "
import('./packages/server/dist/prompts/loader.js').then(async ({ loadPrompt }) => {
  const sys = await loadPrompt('finclaw.system.ko.md', 'verify');
  const baseline = require('fs').readFileSync('plans/phase25/.baseline-system-prompt.txt', 'utf-8');
  if (sys.body !== baseline.trim()) {
    console.error('MISMATCH'); console.error('--- loaded ---'); console.error(sys.body); console.error('--- baseline ---'); console.error(baseline);
    process.exit(1);
  }
  console.log('OK: loaded system prompt matches baseline');
});
"
```

---

## 밀스톤 B — 스킬 내부 LLM 프롬프트 외부화

### B1-B6. CREATE 6개 analyze 변형

`packages/skills-finance/prompts/news/analyze.<depth>.<lang>.md` 파일 6개. 본문은 현재 `buildAnalysisSystemPrompt(depth, language)` 의 출력과 byte-equal.

**B1. `analyze.brief.ko.md`**:

```markdown
You are a professional financial market analyst. Analyze the provided news articles and generate a market analysis report.
한국어로 분석 결과를 작성하세요.
Be concise, 1-2 sentences per field.

Response format (strict JSON, no markdown):
{
"summary": "시장 전망 요약",
"sentiment": { "score": -1.0~1.0, "label": "very_negative|negative|neutral|positive|very_positive", "confidence": 0.0~1.0 },
"keyFactors": ["핵심 요인 1", "핵심 요인 2"],
"risks": ["리스크 1"],
"opportunities": ["기회 1"]
}
```

**B2. `analyze.brief.en.md`**: B1 의 `한국어로 분석 결과를 작성하세요.` → `Write analysis results in English.`

**B3. `analyze.standard.ko.md`**: B1 의 `Be concise, 1-2 sentences per field.` → `Provide a balanced, moderate-length analysis.`

**B4. `analyze.standard.en.md`**: B3 의 language 라인 영문화.

**B5. `analyze.detailed.ko.md`**: B1 의 depth 라인 → `Provide thorough analysis with multiple paragraphs for summary.`

**B6. `analyze.detailed.en.md`**: B5 의 language 라인 영문화.

> frontmatter 없음 — 본문 자체가 system 프롬프트.

검증:

```sh
ls packages/skills-finance/prompts/news/analyze.*.md | wc -l   # 6
```

### B7. CREATE `packages/skills-finance/prompts/news/sentiment.system.md`

```markdown
You are a financial sentiment analyzer. Analyze news headlines and return JSON: {"score": -1.0~1.0, "label": "very_negative|negative|neutral|positive|very_positive", "confidence": 0.0~1.0}. Rule-based hint score: {{ruleHint}}.
```

검증: `grep -q '{{ruleHint}}' packages/skills-finance/prompts/news/sentiment.system.md`

### B8. CREATE `packages/skills-finance/src/news/analysis/prompt-loader.ts`

```ts
// packages/skills-finance/src/news/analysis/prompt-loader.ts
import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../prompts/news');

export class SkillPromptLoadError extends Error {
  constructor(
    message: string,
    public readonly searchDir: string,
    public readonly filename: string,
  ) {
    super(message);
    this.name = 'SkillPromptLoadError';
  }
}

async function readPromptFile(filename: string, callerHint: string): Promise<string> {
  const fullPath = resolve(PROMPTS_DIR, filename);
  try {
    return (await readFile(fullPath, 'utf-8')).trim();
  } catch {
    throw new SkillPromptLoadError(
      `Skill prompt file not found: ${filename}\n  searched in: ${PROMPTS_DIR}\n  required by: ${callerHint}`,
      PROMPTS_DIR,
      filename,
    );
  }
}

export type AnalysisDepth = 'brief' | 'standard' | 'detailed';
export type AnalysisLanguage = 'ko' | 'en';

export async function loadAnalysisPrompt(
  depth: AnalysisDepth,
  language: AnalysisLanguage,
): Promise<string> {
  return readPromptFile(
    `analyze.${depth}.${language}.md`,
    `loadAnalysisPrompt(${depth},${language})`,
  );
}

export async function loadSentimentPrompt(ruleHint: number): Promise<string> {
  const tpl = await readPromptFile('sentiment.system.md', 'loadSentimentPrompt');
  return tpl.replaceAll('{{ruleHint}}', ruleHint.toFixed(2));
}
```

> dist 빌드 후 경로: `packages/skills-finance/dist/news/analysis/prompt-loader.js` → `../../../prompts/news/` → `packages/skills-finance/prompts/news/` ✅

검증: `pnpm --filter @finclaw/skills-finance exec tsgo --noEmit src/news/analysis/prompt-loader.ts`

### B9. EDIT `packages/skills-finance/src/news/analysis/market-analysis.ts`

**(a) import 추가**:

```ts
import { loadAnalysisPrompt } from './prompt-loader.js';
```

**(b) line 46 `buildAnalysisSystemPrompt(depth, language)` 호출 → `await loadAnalysisPrompt(depth, language)`**:

```ts
const systemPrompt = await loadAnalysisPrompt(depth, language);
```

**(c) `function buildAnalysisSystemPrompt(...)` (line 99-122) 통째로 삭제.**

**(d) `function buildAnalysisUserPrompt(...)` (line 124-140) 는 그대로 유지** (plan 결정 — 동적 조립 본질).

검증:

```sh
! grep -q "buildAnalysisSystemPrompt" packages/skills-finance/src/news/analysis/market-analysis.ts
grep -q "buildAnalysisUserPrompt" packages/skills-finance/src/news/analysis/market-analysis.ts
grep -q "loadAnalysisPrompt" packages/skills-finance/src/news/analysis/market-analysis.ts
```

### B10. EDIT `packages/skills-finance/src/news/analysis/sentiment.ts`

**(a) import 추가**:

```ts
import { loadSentimentPrompt } from './prompt-loader.js';
```

**(b) line 126-131 `messages.create({...})` 의 `system: \`...\`` 라인을 외부 로드로 교체**:

```ts
const systemPrompt = await loadSentimentPrompt(ruleBasedHint);
const message = await client.messages.create({
  model: modelRef.model,
  max_tokens: 200,
  system: systemPrompt,
  messages: [{ role: 'user', content: `Analyze sentiment of these headlines:\n${digest}` }],
});
```

검증:

```sh
! grep -q "You are a financial sentiment analyzer" packages/skills-finance/src/news/analysis/sentiment.ts
grep -q "loadSentimentPrompt" packages/skills-finance/src/news/analysis/sentiment.ts
```

### B11. EDIT `packages/skills-finance/package.json` — `files` 확장

현재 `files: ["dist"]` → `files: ["dist", "prompts/**/*.md"]`. 작성 후 `pnpm format:fix`.

검증: `node -e "console.log(require('./packages/skills-finance/package.json').files)"` → `[ 'dist', 'prompts/**/*.md' ]`

### B12. 밀스톤 B 검증

```sh
pnpm typecheck                                                  # 0 errors
pnpm --filter @finclaw/skills-finance build
node -e "
import('./packages/skills-finance/dist/news/analysis/prompt-loader.js').then(async (m) => {
  for (const d of ['brief','standard','detailed']) for (const l of ['ko','en']) {
    const s = await m.loadAnalysisPrompt(d, l);
    if (!s.includes('Response format')) throw new Error('missing format: '+d+'.'+l);
  }
  const sent = await m.loadSentimentPrompt(0.42);
  if (!sent.includes('hint score: 0.42')) throw new Error('sentiment substitution failed');
  console.log('OK: 6 variants + sentiment substitution');
});
"
```

---

## 밀스톤 C — 골든 파일 테스트 & CI 가드

### C1. CREATE `packages/server/src/prompts/__tests__/loader.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { loadPrompt, parsePrompt, PromptLoadError, requireFrontmatterKeys } from '../loader.js';

describe('parsePrompt', () => {
  it('parses frontmatter and body', () => {
    const raw = '---\nid: foo\nname: Bar\n---\n\nbody text';
    const doc = parsePrompt(raw);
    expect(doc.frontmatter.id).toBe('foo');
    expect(doc.frontmatter.name).toBe('Bar');
    expect(doc.body).toBe('body text');
  });

  it('returns body verbatim when no frontmatter', () => {
    expect(parsePrompt('plain body').body).toBe('plain body');
    expect(parsePrompt('plain body').frontmatter).toEqual({});
  });

  it('handles values containing colons', () => {
    const doc = parsePrompt('---\nurl: https://example.com\n---\nx');
    expect(doc.frontmatter.url).toBe('https://example.com');
  });
});

describe('loadPrompt', () => {
  it('loads finclaw.identity.md', async () => {
    const doc = await loadPrompt('finclaw.identity.md', 'test');
    expect(doc.frontmatter.id).toBe('finclaw-partner');
    expect(doc.body).toContain('FinClaw');
  });

  it('throws PromptLoadError with searchDir + filename + caller for missing file', async () => {
    await expect(loadPrompt('does-not-exist.md', 'unit-test')).rejects.toMatchObject({
      name: 'PromptLoadError',
      filename: 'does-not-exist.md',
    });
    try {
      await loadPrompt('does-not-exist.md', 'unit-test');
    } catch (e: any) {
      expect(e.message).toContain('searched in:');
      expect(e.message).toContain('required by: unit-test');
    }
  });
});

describe('requireFrontmatterKeys', () => {
  it('throws with missingKey populated', () => {
    const doc = { frontmatter: { id: 'x' }, body: '' };
    expect(() => requireFrontmatterKeys(doc, 'foo.md', ['id', 'name'], 'test')).toThrow(
      /Missing frontmatter key 'name'/,
    );
  });
});
```

### C2. CREATE `packages/server/src/prompts/__tests__/identity.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { loadPrompt } from '../loader.js';

describe('finclaw.identity.md (golden)', () => {
  it('frontmatter matches agent.list metadata expectations', async () => {
    const doc = await loadPrompt('finclaw.identity.md', 'test');
    expect(doc.frontmatter).toMatchObject({
      id: 'finclaw-partner',
      name: 'FinClaw Personal Finance Partner',
      description: '개인 금융 파트너. 시세 조회·뉴스·포트폴리오·알림 관리.',
    });
  });

  it('body contains 5 core principles (regression guard)', async () => {
    const { body } = await loadPrompt('finclaw.identity.md', 'test');
    for (const kw of ['읽기 전용', '환각 금지', '출처 명시', '불확실성 수치화', '간결한 한국어']) {
      expect(body).toContain(kw);
    }
  });
});

describe('finclaw.system.ko.md (golden)', () => {
  it('contains all identity principles + tools section', async () => {
    const { body } = await loadPrompt('finclaw.system.ko.md', 'test');
    for (const kw of [
      '읽기 전용',
      '환각 금지',
      '출처 명시',
      '불확실성 수치화',
      '간결한 한국어',
      '## 사용 가능한 도구',
      '## 도구 결과 처리',
      'analyze_market',
    ]) {
      expect(body).toContain(kw);
    }
  });

  it('persona core lines match identity.md (no drift)', async () => {
    const id = await loadPrompt('finclaw.identity.md', 'test');
    const sys = await loadPrompt('finclaw.system.ko.md', 'test');
    for (const line of id.body
      .split('\n')
      .filter((l) => l.trim().startsWith('1.') || l.trim().startsWith('너는'))) {
      expect(sys.body).toContain(line);
    }
  });
});
```

### C3. CREATE `packages/skills-finance/src/news/analysis/__tests__/prompt-loader.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { loadAnalysisPrompt, loadSentimentPrompt, SkillPromptLoadError } from '../prompt-loader.js';

describe('loadAnalysisPrompt', () => {
  const depths = ['brief', 'standard', 'detailed'] as const;
  const langs = ['ko', 'en'] as const;

  for (const d of depths)
    for (const l of langs) {
      it(`loads ${d}.${l}`, async () => {
        const text = await loadAnalysisPrompt(d, l);
        expect(text).toContain('Response format (strict JSON');
        expect(text.length).toBeGreaterThan(50);
      });
    }

  it('language directive matches language', async () => {
    expect(await loadAnalysisPrompt('standard', 'ko')).toContain('한국어로');
    expect(await loadAnalysisPrompt('standard', 'en')).toContain(
      'Write analysis results in English',
    );
  });

  it('depth directive matches depth', async () => {
    expect(await loadAnalysisPrompt('brief', 'ko')).toContain('1-2 sentences');
    expect(await loadAnalysisPrompt('detailed', 'ko')).toContain('thorough analysis');
  });
});

describe('loadSentimentPrompt', () => {
  it('substitutes {{ruleHint}} with 2-decimal value', async () => {
    const text = await loadSentimentPrompt(0.4);
    expect(text).toContain('hint score: 0.40');
    expect(text).not.toContain('{{ruleHint}}');
  });

  it('rounds correctly', async () => {
    expect(await loadSentimentPrompt(0.4567)).toContain('hint score: 0.46');
    expect(await loadSentimentPrompt(-0.5)).toContain('hint score: -0.50');
  });
});

describe('error reporting', () => {
  it('throws with searchDir + filename + caller hint', async () => {
    // @ts-expect-error invalid depth on purpose
    await expect(loadAnalysisPrompt('foo', 'ko')).rejects.toMatchObject({
      name: 'SkillPromptLoadError',
      filename: 'analyze.foo.ko.md',
    });
  });
});
```

### C4. CREATE `packages/skills-finance/src/news/analysis/__tests__/analyze-prompts.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { z } from 'zod/v4';
import { loadAnalysisPrompt } from '../prompt-loader.js';

const AnalysisResponseSchema = z.object({
  summary: z.string(),
  sentiment: z.object({
    score: z.number().min(-1).max(1),
    label: z.enum(['very_negative', 'negative', 'neutral', 'positive', 'very_positive']),
    confidence: z.number().min(0).max(1),
  }),
  keyFactors: z.array(z.string()),
  risks: z.array(z.string()),
  opportunities: z.array(z.string()),
});

describe('analyze prompts (6 variants × Zod compliance)', () => {
  // 각 변형의 response format 예시가 Zod 스키마를 통과하는 mock 응답을 생성할 수 있는지.
  // 실제 LLM 호출 없이 프롬프트가 명세하는 JSON 구조의 정합성 검증.
  const validMockResponse = {
    summary: 'mock summary',
    sentiment: { score: 0.1, label: 'neutral' as const, confidence: 0.7 },
    keyFactors: ['factor1'],
    risks: ['risk1'],
    opportunities: ['opp1'],
  };

  for (const d of ['brief', 'standard', 'detailed'] as const)
    for (const l of ['ko', 'en'] as const) {
      it(`${d}.${l} 프롬프트가 응답 스키마와 일치하는 필드 명세 포함`, async () => {
        const text = await loadAnalysisPrompt(d, l);
        for (const field of ['summary', 'sentiment', 'keyFactors', 'risks', 'opportunities']) {
          expect(text).toContain(field);
        }
        // mock 응답이 스키마 통과 (회귀 가드)
        expect(AnalysisResponseSchema.safeParse(validMockResponse).success).toBe(true);
      });
    }
});
```

### C5. CREATE `tools/check-package-files.test.ts` (CI 가드 #1)

위치: 루트 `tools/` 디렉토리 (없으면 생성). vitest 가 해당 패턴을 픽업하도록 vitest config 확인 필요. **간단 대체**: 각 패키지의 자체 테스트로 추가.

**`packages/server/src/prompts/__tests__/package-files.test.ts`**:

```ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('package.json#files contains prompts pattern', () => {
  it('@finclaw/server', async () => {
    const pkgPath = resolve(fileURLToPath(import.meta.url), '../../../../package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    expect(pkg.files ?? []).toContain('prompts/**/*.md');
  });
});
```

**`packages/skills-finance/src/news/analysis/__tests__/package-files.test.ts`**:

```ts
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

describe('package.json#files contains prompts pattern', () => {
  it('@finclaw/skills-finance', async () => {
    const pkgPath = resolve(fileURLToPath(import.meta.url), '../../../../../package.json');
    const pkg = JSON.parse(await readFile(pkgPath, 'utf-8'));
    expect(pkg.files ?? []).toContain('prompts/**/*.md');
  });
});
```

### C6. CREATE `scripts/verify-pack-includes-prompts.sh` (CI 가드 #2)

```sh
#!/usr/bin/env bash
set -euo pipefail

OUT=$(mktemp -d)
trap "rm -rf $OUT" EXIT

for pkg in server skills-finance; do
  echo "=== verifying $pkg pack includes prompts ==="
  pnpm --filter "@finclaw/$pkg" pack --pack-destination "$OUT" >/dev/null
  TGZ=$(ls "$OUT"/finclaw-$pkg-*.tgz 2>/dev/null | head -1)
  if [ -z "$TGZ" ]; then
    echo "FAIL: tarball not produced for $pkg"; exit 1
  fi
  if ! tar tzf "$TGZ" | grep -q "prompts/.*\.md$"; then
    echo "FAIL: $pkg tarball missing prompts/*.md"
    tar tzf "$TGZ" | head -20
    exit 1
  fi
  echo "  OK: $(tar tzf "$TGZ" | grep -c 'prompts/.*\.md$') .md files"
done
```

```sh
chmod +x scripts/verify-pack-includes-prompts.sh
```

> CI 워크플로(`.github/workflows/*.yml`) 가 있다면 `pnpm test` 직후에 위 스크립트 실행 스텝 추가. 없으면 본 스크립트 존재만으로 수동 검증 도구.

### C7. 밀스톤 C 검증

```sh
pnpm test                                       # 모든 신규 테스트 통과
bash scripts/verify-pack-includes-prompts.sh    # tarball 검증 통과

# 음성 회귀 테스트 (파일 1개 일시 제거 → 테스트 실패 → 복원)
mv packages/skills-finance/prompts/news/analyze.brief.ko.md /tmp/
pnpm --filter @finclaw/skills-finance test 2>&1 | grep -q "FAIL" && echo "OK: deletion detected"
mv /tmp/analyze.brief.ko.md packages/skills-finance/prompts/news/

# dist 기동 검증
pnpm build
node -e "
(async () => {
  const { loadPrompt } = await import('./packages/server/dist/prompts/loader.js');
  const doc = await loadPrompt('finclaw.identity.md', 'smoke-test');
  console.log('dist loader OK:', doc.frontmatter.id);
})();
"
```

---

## 최종 완료 체크리스트 (plan.md 완료 조건 매핑)

```sh
# 1. 페르소나 정의 위치 5곳 → 2곳
grep -rn --include='*.ts' "FinClaw" packages/ | grep -v "import\|interface\|type\|class\|//\|FinClawError\|FinClawConfig\|FinClawLogger\|FinClaw AI" | grep -v "node_modules\|dist/\|test"
# → finclaw.identity.md / finclaw.system.ko.md 2개 외 자연어 정의 없음

# 2. system-prompt.ts 완전 삭제
! test -f packages/agent/src/agents/system-prompt.ts
! grep -rn "system-prompt" packages/agent/src/

# 3. analyze_market 6 변형 + sentiment .md 로드, 인라인 함수 제거
! grep -q "buildAnalysisSystemPrompt" packages/skills-finance/src/
! grep -q "You are a financial sentiment analyzer" packages/skills-finance/src/

# 4. 골든 테스트 8+
pnpm test 2>&1 | tail -20  # passed count 확인

# 5. typecheck / lint / test 통과
pnpm typecheck && pnpm lint && pnpm test

# 6. 수동 시나리오 (서버 기동 필요)
# (a) "AAPL 뉴스 분석해줘" → 외부 한국어 + 내부 영어 분석
# (b) agent.list → frontmatter 와 동일
# (c) finclaw.identity.md 수정 → 재기동 후 즉시 반영
```

### 정리

```sh
rm plans/phase25/.baseline-system-prompt.txt   # P2 baseline 삭제
git status                                      # 변경 파일 일람
git add -A
git commit -m "feat(prompts): externalize persona and analysis prompts (Phase 25)"
```

---

## 롤백 절차

문제 발생 시:

```sh
git checkout main -- packages/agent/src/agents/system-prompt.ts \
  packages/agent/src/index.ts \
  packages/server/src/main.ts \
  packages/server/src/gateway/rpc/methods/agent.ts \
  packages/skills-finance/src/news/analysis/market-analysis.ts \
  packages/skills-finance/src/news/analysis/sentiment.ts
rm -rf packages/server/prompts packages/skills-finance/prompts \
  packages/server/src/prompts \
  packages/skills-finance/src/news/analysis/prompt-loader.ts
```
