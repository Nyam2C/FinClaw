# Phase 44 Todo (초안) — dead-code sweep(공격적) + 부팅 안전장치 배선 + 서브에이전트 파일 정의(M4)

> `plans/phase44/plan.md`(결정§0, 안전§1, 마일스톤§2, 리스크§3)을 코드 단위로 분해.
> base = `feature/phase44` (HEAD `50035f4`, base main `2332e7d` = phase43 머지). phase43 M1~M3 머지됨, **M4 미구현**(router/ 에 agent-loader.ts·prompts/sub-agents/ 없음).
> 분해 원칙: **plan 의 결정·범위 확장 금지(§3 외과적).** 인벤토리에 없는 코드 불변. false positive(재검증서 소비처 발견) 는 삭제 말고 review 기록.
>
> **밀스톤 순서(plan §2 + 사용자 지시):** M-A(M4) → M-B(부팅 배선+gatewayLock 삭제) → C1 types → C2 infra → C3 storage(+M-D 흡수) → C4 agent → C5 skills → C6 gateway → C7 server → C8 clients.
> M-B 를 C 앞에 두는 이유: M-B 가 보존·배선하는 `loadDotenv`/`assertSupportedRuntime`/`setupUnhandledRejectionHandler` 를 C2 가 실수로 안 지우게(배선이 먼저 들어가 grep 소비처가 생김). M-A 를 맨 앞: M4 가 활성화하는 `AgentProfile`(types)·로더가 C1 types 삭제 전에 확정돼야 cascade 오판 방지.

---

## 검증 게이트 (매 밀스톤 공통 — G)

각 밀스톤 종료 시 아래 **전부** 통과해야 다음으로 (phase42 교훈: tsgo+vitest 만으론 broken build 못 잡음 — `pnpm build`=`tsc --build` 필수):

```
pnpm format        # oxfmt
pnpm lint          # oxlint
pnpm typecheck     # tsgo --noEmit
pnpm build         # tsc --build (project references — 배럴 drift·cascade 적발)
pnpm test --run    # vitest 전체 (회귀 0)
```

- 밀스톤마다 **1 커밋, subject ASCII** (lefthook conventional + C.UTF-8 grep 한계).
- 삭제 커밋 = `refactor(phase44): remove dead <area>` + 본문에 제거 심볼·재검증 근거(rg 결과).

## 재검증 절차 (C 시리즈 각 삭제 직전 — RV)

> plan §1.1: 감사 77건은 sonnet grep 산출 → false positive 가능. 삭제 직전 1심볼씩:

```
rg "\bSYMBOL\b" packages/*/src --glob '!**/dist/**'
```

- **비-self·비-test 소비처 0** → 삭제 진행.
- **소비처 1+ 발견** → **삭제 보류**. `_workspace/phase-execute/phase44-holds.md` 에 (심볼·위치·발견 소비처·감사 오판 여부) 기록 → review.md 로 승계. **추측으로 소비처 같이 지우지 말 것**(범위 확장).
- 배럴 re-export·전용 테스트·고아 import 는 심볼과 **동반** 삭제(plan §1.4). 단 무관 인접 코드 불변.

---

## 보존 불변 (전 밀스톤 — 삭제 절대 금지)

메모리 RAG · cron(schedule_manage + automation/scheduler) · read-only · 매수=사람 · 키없이부팅 · thin orchestrator(phase43 route_task/dispatch/sub-agent) · **alerts live 경로(`skills-finance/src/alerts/` 전체)** · `getNodeMajorVersion`(plugins/loader.ts:87 live) · `runWithModelFallback` 코어(서킷브레이커·retry·cross-provider) · `calculateEstimatedCost` · `classifyFallbackError` · `classifyError`(unhandled-rejections, 테스트+M-B 배선) · `loadPlugins` MCP 도구 경로.

---

# M-A — 서브에이전트 파일 정의 (M4, phase43 이월)

> 목표(plan §2 M-A): `prompts/sub-agents/market_analysis.md`(frontmatter) + `router/agent-loader.ts`(파서+test) + `dispatchMarketAnalysis`/route-task intent 로더 기반 재구성 + `AgentProfile`(types, dead) 활성화.
>
> **★ 스코프 정정(실측 — 구현자 필독):** plan/phase43-M4 가 전제한 "market_analysis sub-agent system prompt 가 dispatch.ts 에 하드코딩 → 파일로 이전"은 **이미 부분 충족**. 실제 system prompt 는 `skills-finance/src/news/analysis/prompt-loader.ts:loadAnalysisPrompt(depth,language)` 가 `prompts/news/analyze.{depth}.{language}.md` 에서 로드(market-analysis.ts:89). `dispatch.ts:dispatchMarketAnalysis` 는 하드코딩 프롬프트 없음 — `ANALYSIS_MODEL_ID='claude-opus-4-7'`/`ANALYSIS_QUEUE_KEY` 상수만 인라인. 따라서 M4 의 실효 작업 = **(1) frontmatter 메타(id/name/model/source) 파일화 + 로더 토대 + (2) dispatch 의 인라인 model 상수를 로더 정의에서 끌어오기 + (3) AgentProfile 활성화.** 분석 출력 schema·`analyzeMarket` 로직·`loadAnalysisPrompt` 는 **불변**(phase42 완료, §3 외과적).
> **★ route-task.ts ROUTE_INTENTS 동적화는 분리(plan §2 범위 주의):** `registerRouteTaskTool(registry, dispatcher, intents)` 시그니처 변경은 server→skills-general 로 intent 주입 필요(skills-general 이 server 를 import 못 함). M4 토대(파일+로더+dispatch model)만 두고 **동적화는 M-A-5 에서 시그니처 주입형으로**, 크면 phase45 분리(아래 명시).

### M-A-1. CREATE `packages/server/prompts/sub-agents/market_analysis.md` — sub-agent 메타 frontmatter

frontmatter(id/name/model/source/description) + 본문(요약 가이드). **system prompt 본체는 여전히 prompt-loader.ts 가 로드 — 이 파일의 본문은 메타 설명용**(중복 프롬프트 도입 금지, §3). 기존 `prompts/loader.ts:parsePrompt` 가 파싱 가능한 포맷(`---\n...\n---\n본문`) 일치 확인.

```md
---
id: market_analysis
name: Market Analysis Sub-Agent
model: claude-opus-4-7
source: sub-agent
description: 뉴스를 종합해 시장 전망·감성·리스크/기회를 분석한다.
---

뉴스 종합 시장 분석 서브에이전트. 실제 분석 system prompt 는
skills-finance prompt-loader (analyze.{depth}.{language}.md) 가 공급한다.
```

- 검증: 파일 frontmatter 파싱(M-A-3 로더 테스트가 검증). `model: claude-opus-4-7` 이 `dispatch.ts:ANALYSIS_MODEL_ID` 와 일치(현행 보존).

### M-A-2. GREP 선행 — 기존 프롬프트 로더 재사용 여부 확정

`prompts/loader.ts` 에 `parsePrompt`(frontmatter+body 파서) **이미 존재**(loader.ts:39, `requireFrontmatterKeys` 동반). **신규 YAML 파서 도입 금지(§3 의존성 확장).** agent-loader 는 디렉터리 순회만 추가하고 파싱은 `parsePrompt` 재사용.

- 검증: `rg -n "parsePrompt|requireFrontmatterKeys" packages/server/src/prompts/loader.ts` → export 확인(둘 다 export).

### M-A-3. CREATE `packages/server/src/router/agent-loader.ts` — sub-agent 정의 디렉터리 로더

`prompts/sub-agents/*.md` 순회 → `parsePrompt` 로 frontmatter+body 파싱 → `id→SubAgentDefinition` 맵. **`parsePrompt` 재사용**(phase43 todo M4-2 스니펫의 자체 정규식 파서는 폐기 — 중복).

```ts
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePrompt } from '../prompts/loader.js';

const SUB_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/sub-agents');

export interface SubAgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly source: 'sub-agent' | 'function';
}

/** prompts/sub-agents/*.md frontmatter → id→정의 맵. body 는 메타 설명(미사용). */
export function loadSubAgents(dir: string = SUB_AGENTS_DIR): Map<string, SubAgentDefinition> {
  const map = new Map<string, SubAgentDefinition>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue;
    const { frontmatter } = parsePrompt(readFileSync(join(dir, file), 'utf-8'));
    const id = frontmatter.id;
    if (!id) throw new Error(`sub-agent file ${file} missing frontmatter id`);
    map.set(id, {
      id,
      name: frontmatter.name ?? id,
      model: frontmatter.model ?? 'claude-opus-4-7',
      source: (frontmatter.source as SubAgentDefinition['source']) ?? 'sub-agent',
    });
  }
  return map;
}
```

> `SubAgentDefinition.systemPrompt` 필드 **불포함** — system prompt 는 skills-finance prompt-loader 소관(중복 금지). M4 토대는 intent→(model,source) 매핑까지만.

- 검증: `pnpm --filter @finclaw/server build`

### M-A-4. CREATE `packages/server/src/router/agent-loader.test.ts` — 로더 unit test (외부 키 0)

`loadSubAgents(tmpdir)` 가 frontmatter 파싱·id 누락 throw 를 검증. 임시 디렉터리에 fixture .md 작성(네트워크·실 CLI 0).

```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSubAgents } from './agent-loader.js';

describe('sub-agent loader', () => {
  it('loads frontmatter into id→definition map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-'));
    writeFileSync(
      join(dir, 'market_analysis.md'),
      `---\nid: market_analysis\nname: MA\nmodel: claude-opus-4-7\nsource: sub-agent\n---\nbody`,
    );
    const map = loadSubAgents(dir);
    expect(map.get('market_analysis')?.model).toBe('claude-opus-4-7');
    expect(map.get('market_analysis')?.source).toBe('sub-agent');
  });

  it('throws when frontmatter id missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-'));
    writeFileSync(join(dir, 'bad.md'), `---\nname: x\n---\nbody`);
    expect(() => loadSubAgents(dir)).toThrow();
  });
});
```

- 검증: `pnpm test --run --filter @finclaw/server` (agent-loader.test.ts green)

### M-A-5. EDIT `dispatch.ts` + `route-task.ts` — 로더 기반 재구성 (AgentProfile 활성화) ★범위 분기점

분해 시 두 갈래 — **시간/리스크 따라 택1**:

**(a) 최소 토대(권장 — 회귀 0, M-A 안에 닫힘):**

- `dispatch.ts`: `loadSubAgents()` 맵을 `buildRouteDispatcher` 진입 시 1회 로드, `dispatchMarketAnalysis` 가 인라인 `ANALYSIS_MODEL_ID` 대신 `map.get('market_analysis').model` 사용. `ANALYSIS_QUEUE_KEY` 는 코드 상수 유지(파일 메타 아님).
- `AgentProfile`(types/agent.ts:10) 활성화 = `SubAgentDefinition` 을 `AgentProfile` 형태(`{id,name,model:ModelRef,agentDir}`)로 맞출지 결정. **단 `AgentProfile.model` 은 `ModelRef={provider,model}`, 로더 frontmatter 는 model string** → 매핑 어댑터 필요. **AgentProfile 을 그대로 쓰면 agentDir 필드 의미 부여가 필요**(prompts/sub-agents 경로). 과설계 회피: SubAgentDefinition 으로 충분하면 AgentProfile 활성화는 "타입 재사용" 수준(import 후 형태 정렬)에 그치고, 억지 배선 금지(§2).
- route-task.ts `ROUTE_INTENTS` **하드코딩 유지**(동적화 X).

**(b) intent 동적화(plan 범위 주의 — 크면 phase45):**

- `registerRouteTaskTool(registry, dispatcher, intents: readonly RouteIntent[])` 시그니처 확장. server `composition/skills.ts` 가 `loadSubAgents()` + 함수 intent 합쳐 `intents` 주입(skills-general 은 server 미import 제약 충족 — 주입 방향 server→skills-general).
- route-task.ts:6 `ROUTE_INTENTS` 하드코딩 제거 → 주입 인자 사용. route-task.ts:59 `ROUTE_INTENTS.includes` 도 주입 목록 기반.

> **권고:** (a) 를 M-A 에 커밋. (b)(동적화)는 표면이 크고 C5 의 `route-task.ts ROUTE_INTENTS.includes 도달불가` 와 얽힘 → **C5 와 함께 처리하거나 phase45 분리**(plan §3 "크면 로더 토대만"). 본 todo 는 (a) 기준으로 검증 단계 작성, (b) 착수 시 dispatch.ts/route-task.ts 재-Read 후 시그니처 정합.

- 검증: `pnpm --filter @finclaw/server build && pnpm --filter @finclaw/skills-general build`

### M-A-G. 밀스톤 M-A 검증 + smoke

- 전체 게이트 **G**.
- market_analysis smoke: `buildRouteDispatcher` 가 로더 정의 model 로 sub-agent 경로를 타는지(mock `runSubAgent`/`analyzeMarket` runner — 실 CLI spawn 0). 기존 dispatch.test.ts 회귀 0.
- 커밋: `feat(phase44): file-based sub-agent definitions (agentDir loader)`

> **M-A 미완/초과 시:** M-A-1~M-A-4(로더 토대)+M-A-5(a) 까지 커밋, (b) 동적화는 phase45. review 에 사유 기록.

---

# M-B — 부팅 안전장치 배선 + gatewayLock 삭제

> 결정§0: `loadDotenv`·`assertSupportedRuntime`·`setupUnhandledRejectionHandler` **배선**(main.ts), `acquireGatewayLock`+`gateway-lock.ts` **삭제**.
> ★ M-B 가 C2 보다 먼저여야 C2 가 dotenv/runtime-guard/unhandled-rejection 을 안 지움(배선으로 소비처 생성).

### M-B-1. EDIT `packages/server/src/main.ts` — 부팅 진입부 안전장치 3종 배선

main.ts 부팅 시퀀스 실측(현행):

- `main()` 본문 시작 = §61. 첫 동작 = §63 `loadPrompt`.
- env 검증 = §79~88(`requireEnv`).
- logger 생성 = §91 `createLogger`.

배선 위치(외과적 — 최소 삽입):

1. **`loadDotenv()`** — `main()` 최상단(§62, `loadPrompt` 전, config/env 로드 전). 또는 `main()` 호출 전 모듈 스코프(`if (!process.env.VITEST)` 가드 안, §393 직전). **VITEST 시 미실행** 주의(테스트가 .env 로드 부작용 안 받게) → `if (!process.env.VITEST)` 블록 안 또는 `main()` 첫 줄+VITEST 가드. 실측 후 결정: `loadDotenv` 가 idempotent·실패 무해하면 `main()` §62 최상단이 단순.
2. **`assertSupportedRuntime()`** — `loadDotenv` 직후(Node22 가드, config 로드 전 조기 실패).
3. **`setupUnhandledRejectionHandler(logger)`** — logger 생성(§91) **직후**(§92 lifecycle 생성 전). logger 인자 시그니처 `{warn,error}` = `createLogger` 결과 호환 확인.

import 추가(§14-22 infra import 블록):

```ts
import {
  assertPortAvailable,
  assertSupportedRuntime, // 추가
  ConcurrencyLane,
  createLogger,
  formatPortOccupant,
  getEventBus,
  inspectPortOccupant,
  loadDotenv, // 추가
  PortInUseError,
  setupUnhandledRejectionHandler, // 추가
} from '@finclaw/infra';
```

> 정확한 삽입 라인은 착수 시 main.ts §61-92 재-Read 후 확정. **무관 인접 코드 불변**(§3).

- 검증: `pnpm --filter @finclaw/server build`

### M-B-2. DELETE `packages/infra/src/gateway-lock.ts` + 배럴 + 테스트

RV 재검증: `rg "\bacquireGatewayLock\b|\breadLockInfo\b|\bGatewayLockError\b|\bGatewayLockHandle\b|\bGatewayLockOptions\b" packages/*/src --glob '!**/gateway-lock.ts'`

- **실측 근거:** 비-self·비-test 소비처 0. 5심볼 전부 gateway-lock.ts 자체 + `infra/test/gateway-lock.test.ts` + `infra/index.ts:96-101` 배럴 only(REPORT A:67).

삭제 대상:

- `packages/infra/src/gateway-lock.ts` (파일 전체, 148 LOC).
- `packages/infra/test/gateway-lock.test.ts` (전용 테스트).
- `packages/infra/src/index.ts:95-101` 배럴 블록(`acquireGatewayLock`/`readLockInfo`/`GatewayLockError`/`GatewayLockHandle`/`GatewayLockOptions`). **`assertPortAvailable`/`findAvailablePort`/`isValidPort`(§102 ports.js)·`inspectPortOccupant`(§103) 는 별 파일 — 불변.**
- `packages/infra/src/errors.ts:56` stale 주석(`GatewayLockError → gateway-lock.ts (co-located)`) — 고아 주석 동반 정리(§1.4).

> ★ 주의: `index.ts` §95 주석 `// 프로세스` 블록은 ports 도 포함 → 주석 헤더 삭제 금지(ports 가 남음). gateway-lock export 4줄만 제거.

- 검증: `pnpm --filter @finclaw/infra build`

### M-B-G. 밀스톤 M-B 검증 + 부팅 smoke

- 전체 게이트 **G**.
- 부팅 smoke(가능 시): 키 없이 `pnpm dev` 가 .env 자동 로드 + Node22 가드 통과(`loadDotenv` 효과 = MEMORY "env 자동 로드 안 함" 해소 확인). 실 부팅 불가 시 unit/build 로 대체.
- 커밋: `refactor(phase44): wire boot safety guards, remove gateway-lock`

---

# C1 — types (★ cascade 최위험, 바텀업 첫 단계)

> plan §3: 타입 제거가 전 시스템 break 유발 가능 → RV 철저, 한 심볼씩 build 게이트.
> 삭제 후보(REPORT A:60-64): `Opaque`/`DeepPartial`/`DeepReadonly`(common.ts:5,11,16) · `SkillDefinition 클러스터 8`(skill.ts:5,14,17,26,35,43,50,58) · `TechnicalAnalysisResult 3`(finance.ts:75,78,86) · `MarketDataRequest`/`MarketDataResponse`/`AlertTrigger`(finance.ts:56,65,150).

### C1-1. RV — types 후보 전수 재검증

각 심볼 `rg "\bSYMBOL\b" packages/*/src --glob '!**/dist/**'` 비-self·비-test 0 확인. **특히:**

- `SkillDefinition` 클러스터: REPORT 가 "7타입 내부 상호참조만, 신세대 `SkillMetadata`(5소비)가 정본" → 클러스터 8타입이 서로만 참조하는지(외부 0) 확인 후 통째.
- `AlertTrigger` vs `Alert`(본체 live) 혼동 금지 — `AlertTrigger`(finance.ts:150) 만 dead, `Alert`/`createAlert` 도메인 live.
- `TechnicalAnalysisResult` vs finance core(`TickerSymbol`/`Quote` 등 live) 분리.
- 발견 소비처 → holds.md 기록·보류.

### C1-2. DELETE common.ts dead 타입

`Opaque`(common.ts:5)·`DeepPartial`(11)·`DeepReadonly`(16) 삭제. `Brand`(live) 불변. 배럴(types/index.ts) re-export 동반 제거.

- 검증: `pnpm build` (전 패키지 cascade 즉시 적발).

### C1-3. DELETE skill.ts 구세대 SkillDefinition 클러스터(8타입)

skill.ts:5,14,17,26,35,43,50,58 의 `SkillDefinition` + 종속 7타입 통째. `SkillMetadata`(정본, 5소비) **불변**. 배럴 동반.

- 검증: `pnpm build`

### C1-4. DELETE finance.ts dead 타입(6)

`MarketDataRequest`(56)·`MarketDataResponse`(65)·`TechnicalAnalysisResult 클러스터`(75,78,86)·`AlertTrigger`(150). finance core(`Alert`·`Quote`·`NewsItem`·`Portfolio` 등) 불변. 배럴 동반.

- 검증: `pnpm build`

### C1-G. 밀스톤 C1 검증

- 전체 게이트 **G** (cascade 가 build 에서 드러남).
- 커밋: `refactor(phase44): remove dead types (common/skill/finance)`

> **HOLD 분기:** C1-1 RV 에서 소비처 발견(예: test 외 import) 시 해당 심볼만 보류, 나머지 진행. test-only 소비(keep-but-noted: `ErrorReason`/`Result`/`GetReplyOptions`/`ConfigFileSnapshot`)는 **C1 대상 아님**(REPORT keep-but-noted) — 건드리지 말 것.

---

# C2 — infra (M-B 보존분 제외)

> plan §2 C2 + §3: `loadDotenv`/`runtime-guard`/`unhandled-rejections` 는 **M-B 가 배선하므로 C2 제외**. `getNodeMajorVersion` 도 LIVE(plugins/loader.ts:87) → **runtime-guard.ts 파일 불변.**
> C2 대상(REPORT A:65,66,71,72,73 + B:103): `agent-events.ts`(전체 6함수)·`paths.ts`(전체 8함수, config paths 중복)·`env.ts` 헬퍼 5(server requireEnv shadow)·`auth:resolve` 이벤트(events.ts:64)·test-only 유틸 다수·배럴 over-export.

### C2-1. RV — infra 후보 재검증 (M-B 배선분 제외 확인)

- **제외 확인:** `loadDotenv`·`assertSupportedRuntime`·`setupUnhandledRejectionHandler`·`getNodeMajorVersion` 는 M-B 배선 후 소비처 1+ → **삭제 금지.** RV 에서 이들 소비처(main.ts/plugins/loader.ts) 확인되면 정상.
- `agent-events.ts` 6함수(emitAgentRunStart/End/Error, onAgentRunStart/End/Error): `rg` 비-self·비-test 0 확인. REPORT: bridge.ts 가 직접 bus.emit 우회.
- `paths.ts` 8함수(getStateDir/getDataDir/...): prod 0, config 자체 paths 확인.
- `env.ts` 헬퍼 5(normalizeEnv/getEnv/requireEnv/isTruthyEnvValue/logAcceptedEnvOption): server requireEnv(main.ts:53) 는 **별도 정의**(shadow) — infra env 헬퍼 비-self·비-test 0 확인. **server requireEnv 불변.**
- `auth:resolve` 이벤트 타입(events.ts:64): emit/on 0(결정3 resolver 삭제로 orphan).
- test-only(REPORT A:72,73): `EventMap`/`defaultLoggerFactory`/`peekSystemEvents`/`resetForTest`/`resolveRetryConfig`/`findAvailablePort`/`isValidPort`/`readFileSafe`/`unlinkSafe`/`readJsonFileSync`/`wrapError`/`extractErrorInfo`/`formatDuration`/`warnOnce`/`resetWarnings`/`isMain`. **각각 RV** — 일부 live 가능성(저우선, 발견 시 보류).
- 배럴 over-export(B:103): `createTypedEmitter`/`validateUrlSafety`/`isPrivateIp` 외부 0·내부 1 live → 배럴 격하만(파일 불변).
- **system-events `clearSystemEvents`/`onContextKeyChange`:** REPORT §4 "큐 누수 방지 부활 권고" → **삭제 금지·HOLD**(회귀 위험, review 기록). C2 삭제 대상 아님.

### C2-2. DELETE agent-events.ts (전체) + 배럴

파일 + index.ts:77-84 배럴 블록(6 export) 삭제. 전용 테스트 있으면 동반.

- 검증: `pnpm build`

### C2-3. DELETE paths.ts (전체) + 배럴

파일 + index.ts:37-46 배럴(8 export) 삭제. config paths 와 중복 — config 측 불변(소비처는 config paths).

- 검증: `pnpm build`

### C2-4. DELETE env.ts 헬퍼 5 + 배럴 + auth:resolve

- `env.ts` 5함수 + index.ts:36 배럴. server requireEnv 불변.
- `events.ts:64` `auth:resolve` 이벤트 타입 1줄(FinClawEventMap 멤버) 제거. emit/on 0 확인됐을 때만.
- 검증: `pnpm build`

### C2-5. DELETE test-only 유틸 + 배럴 다이어트 (저우선, RV 통과분만)

C2-1 에서 비-self·비-test 0 확인된 것만. 배럴 over-export(createTypedEmitter 등)는 외부 0 이면 배럴 export 제거(정의 파일 불변). **불확실하면 보류**(저우선 — phase45 이월 후보).

- 검증: `pnpm build`

### C2-G. 밀스톤 C2 검증

- 전체 게이트 **G**.
- 커밋: `refactor(phase44): remove dead infra (agent-events/paths/env helpers/auth-resolve)`

---

# C3 — storage (+ M-D 흡수)

> plan §2 C3 + M-D: `tables/messages.ts`(전체)·`tables/alerts.ts`(전체 — **M-D latent bug 동반 해소**)·`atomicReindex`·`purgeExpiredCache` 등 test-only·배럴 over-export·`rerankResults`(server 인라인 중복).
> REPORT A:75,76,77,78,79,80 + B:107,108.

### C3-1. RV — storage 후보 재검증

- `tables/messages.ts`(4함수+3타입): prod·test 0(conversations 가 messages blob 저장 → orphan) 확인.
- `tables/alerts.ts` 전체: **실측 — `createAlert`(44)·`updateAlertTrigger`(91) 비-self·비-test 소비처 0 확인됨**(updateAlertTrigger 도 index.ts:77 배럴만). **★ alerts live 경로(`skills-finance/src/alerts/`)는 자체 store(store.ts) 사용 — 이 storage 파일 미사용.** 혼동 금지: 삭제 대상 = `storage/src/tables/alerts.ts`, **불변 = `skills-finance/src/alerts/` 전체.**
- `atomicReindex`(reindex.ts:22): prod·test 0(차원 교체 미배선). 결정§0 = 스캐폴드 삭제 → 제거.
- `rerankResults`+`RerankMeta`/`RerankOptions`(search/hybrid.ts:60,23,31): **RV 직접 grep** — 비-test 소비 0, server memory-retrieval.ts:337 `reranker.rerank` 인라인 호출(중복). REPORT §5.1 storage lane 채택. **단 `reranker`/`LocalReranker` 본체가 hybrid.ts 와 분리인지 확인** — `rerankResults`(상위 래퍼)만 dead, 하위 reranker 클래스 live 가능 → 래퍼만 삭제.
- test-only(B:107,108 + A:78): `updateAgentRunCliSession`·`createConversation`/`chunkMarkdown`/`recomputeHoldings`(배럴 over-export)·`listConversations`/`getMemoriesBySession`/`getMemoryChunks`/`purgeExpiredCache`. 각 RV. **`purgeExpiredCache` 미배선→캐시 무한성장**은 REPORT 지적이나 결정§0 = 스캐폴드 삭제 → 제거(단 cron purge 경로가 별도 live 인지 확인, live 면 보류).
- 배럴 over-export(A:79): storage 밖 import 0 인 타입 다수(`EmbeddingConfig`/`MemoryChunk`/`MarketCacheEntry`/`SpanRow`/... ) → 배럴 export 제거(정의 불변).

### C3-2. DELETE tables/messages.ts (전체) + 배럴

파일 + index.ts 배럴(4함수+3타입). **테이블 DROP 신중**(REPORT A:75) — DDL/마이그레이션이 messages 테이블 생성하면 그건 별개(스키마 파일 불변, 코드 함수만 제거). 마이그레이션 충돌 없는지 build+test 로 확인.

- 검증: `pnpm build`

### C3-3. DELETE tables/alerts.ts (전체) + 배럴 — M-D latent bug 해소

파일 전체(`createAlert`/`updateAlertTrigger`/타입) + index.ts:77 배럴. **DDL 불일치 latent bug(condition_value/condition_field) 가 파일 삭제로 자연 해소**(M-D). 전용 테스트 있으면 동반.

- ★ **M-D 회귀 가드:** 삭제 후 `skills-finance/src/alerts/` 테스트(monitor/store/tools) 전부 green = alerts live 경로 회귀 0 확인(plan §2 M-D).
- 검증: `pnpm build && pnpm test --run --filter @finclaw/skills-finance`

### C3-4. DELETE atomicReindex + rerankResults 래퍼 + test-only

- `reindex.ts:22` `atomicReindex` + 배럴.
- `search/hybrid.ts` `rerankResults`+`RerankMeta`/`RerankOptions`(60,23,31) — 래퍼만, 하위 reranker live 보존.
- C3-1 RV 통과한 test-only(updateAgentRunCliSession 등) + 배럴 다이어트.
- 검증: `pnpm build`

### C3-G. 밀스톤 C3 검증 (+ M-D)

- 전체 게이트 **G** + alerts live 경로 회귀 0(C3-3 가드).
- 커밋: `refactor(phase44): remove dead storage (messages/alerts tables, atomicReindex, rerank wrapper)`

> **M-D 는 별 단계 없음 — C3-3 에 흡수**(plan §2 M-D 명시). review 에 "M-D = alerts.ts 삭제로 해소, live 경로 회귀 0" 기록.

---

# C4 — agent

> plan §2 C4: 압축 서브시스템(`agents/context/{window-guard,compaction}`+배럴+테스트)·`forceToolChoice`/`forceToolName` plumbing(endpoint 만)·`provider-normalize`(SDK-era)·`FailoverError`/`maskApiKey`·**세션 클러스터**(`agents/session/*`)·`BUILT_IN_GROUPS`·`buildDispatcher` `toolDefinitions`(test-only).
> REPORT E:154,156,157 + A:81,82 + B:109,110 + D buildDispatcher.

### C4-1. RV — agent 후보 재검증 (★ forceToolName 부분 dead 주의)

- **압축 서브시스템(E:154):** `evaluateContextWindow`(window-guard.ts:48)·`compactContext`(compaction.ts:126). 비-self=barrel only, prod 0(결정2 gut 후 orphan). `agents/context/index.ts` 배럴 + 전용 테스트 동반.
- **세션 클러스터(B:109):** `agents/session/*`(write-lock.ts/transcript-repair.ts/tool-result-guard.ts) — `acquireWriteLock`/`resetHeldLocks`/`detectCorruption`/`repairTranscript`. prod 0 test-only(CLI --resume 자체 관리). **결정§0 = 미완 토대 삭제 → 제거.** 단 RV 에서 runner/execution 이 동적 참조 안 하는지 확인(false positive 차단).
- **provider-normalize(A:81):** `normalizeAnthropicResponse`+`NormalizedResponse`/`NormalizedUsage`/`StopReason`(provider-normalize.ts:70). barrel+test, SDK-era. **★ `calculateEstimatedCost`(동 파일) live(market-analysis.ts:3 소비) → 파일 통째 삭제 금지, normalize 심볼만.**
- **FailoverError/maskApiKey(A:82):** errors.ts. prod 0 test-only(CLI OAuth 전환). **★ `classifyFallbackError`(동 파일) live → 보존.**
- **BUILT_IN_GROUPS(B:110):** groups.ts:29. prod 0(PolicyRule 기반). 그룹 타입은 gateway live → 값만 dead.
- **forceTool\* (E:156,157) — ★부분 dead:** `forceToolChoice`(adapter.ts:17 계약) runner 채우나 CLI 미참조. `forceToolName`(runner.ts:127,137,244,265) — **265 만 CLI 무효, 127~244 는 retry 흐름 LIVE.** REPORT: "'통째 dead' 오판 금지." → **endpoint(265)만 도려냄, retry plumbing 보존.** RV 로 127/137/244 가 retry 에서 실제 읽히는지 확인 후 265 만.
- **buildDispatcher toolDefinitions(D):** test-only 인자 — RV 후 제거(단 buildDispatcher 본체·route_task dispatch live, 인자만).

### C4-2. DELETE 압축 서브시스템 (agents/context/)

`agents/context/{window-guard,compaction}.ts` + `index.ts` 배럴 + agent/index.ts:141-142 배럴 + 전용 테스트. (safeTarget 음수 버그 동반 소멸 — REPORT E:154.)

- 검증: `pnpm build`

### C4-3. DELETE 세션 클러스터 (agents/session/)

RV 통과 시 `agents/session/{write-lock,transcript-repair,tool-result-guard}.ts` + `index.ts` 배럴 + agent/index.ts:125-131 배럴 + 테스트. **HOLD-if-live:** runner/execution 동적 참조 발견 시 보류·기록(plan §3 세션 클러스터 false positive 명시 대상).

- 검증: `pnpm build`

### C4-4. DELETE provider-normalize 심볼 + FailoverError/maskApiKey + BUILT_IN_GROUPS

- `provider-normalize.ts`: normalize 심볼 4 + agent/index.ts:29,35 배럴. **`calculateEstimatedCost` 보존**(동 파일 남김).
- `errors.ts`: `FailoverError`/`maskApiKey` + index.ts:4 배럴. **`classifyFallbackError` 보존.**
- `groups.ts:29` `BUILT_IN_GROUPS` 값 + index.ts:107 배럴. 그룹 타입 보존.
- 검증: `pnpm build`

### C4-5. DELETE forceToolName endpoint(265) + forceToolChoice 계약 — ★ retry plumbing 보존

- `runner.ts:265` endpoint 분기만 제거(127/137/244 retry 흐름 불변 — RV 확인분).
- `adapter.ts:17` `forceToolChoice` 계약 필드 제거(runner 가 채우던 곳 동반).
- buildDispatcher test-only `toolDefinitions` 인자(C4-1 RV 통과분).
- 검증: `pnpm build`

### C4-G. 밀스톤 C4 검증

- 전체 게이트 **G**.
- 커밋: `refactor(phase44): remove dead agent (compaction/session/provider-normalize/forceTool)`

> **HOLD 후보 집중 구역(plan §3):** 세션 클러스터·압축 = 미완 토대 스캐폴드. 결정§0 은 삭제이나 RV 에서 동적 참조 발견 시 보류 우선. 발견 0 이면 삭제 진행.

---

# C5 — skills

> plan §2 C5: `defaultModel`/`ANALYZE_MARKET_FALLBACK_MODEL` dead plumbing(phase43 P1)·`ROUTE_INTENTS.includes` 도달불가(M-A 조율)·skill.ts minModel stale 주석.
> ★ **실측 정정(구현자 필독):** `ANALYZE_MARKET_FALLBACK_MODEL`(news/tools.ts:31)·`defaultModel`(tools.ts:108,165, news/index.ts:37,108) 은 **현재 `registerAnalyzeMarketTool` 안에서 참조됨**(tools.ts:165 `deps.defaultModel ?? ANALYZE_MARKET_FALLBACK_MODEL`). phase43 M3 가 `analyze_market` 도구를 **unregister**(메인 노출 제거)했고 route_task `dispatchMarketAnalysis` 는 자체 `ANALYSIS_MODEL_ID` 사용 → analyze_market **도구 등록 경로 자체가 죽은 통로**. 따라서 dead 는 맞으나 **"심볼이 grep 0" 이 아니라 "도구 등록 경로 전체가 unregister 로 도달불가"** → 삭제 = `registerAnalyzeMarketTool` 의 defaultModel 분기 제거(또는 도구 등록 자체 검토). **RV 에서 analyze_market 도구가 정말 어디서도 register 후 live 호출 안 되는지 확인**(skills.ts:142 unregister 흔적). live 면 보류.

### C5-1. RV — skills 후보 재검증

- `ANALYZE_MARKET_FALLBACK_MODEL`/`defaultModel`: `registerAnalyzeMarketTool` 가 등록한 `analyze_market` 도구가 phase43 M3 unregister 후 호출 가능한지. **불가(도달불가) 확인 시** defaultModel plumbing(tools.ts:31,108,165 + news/index.ts:37,108) 제거 가능. **단 `analyzeMarket()` 자체는 route_task 경로에서 live → 함수 불변, 도구 등록 래퍼의 model 주입만.** 모호하면 보류(§3, review 기록).
- `ROUTE_INTENTS.includes`(route-task.ts:59): M-A-5 (a) 선택 시 ROUTE_INTENTS 하드코딩 유지 → includes 도 유효(도달불가 아님). **M-A-5 (b)(동적화) 했을 때만** 도달불가 정리 대상. M-A-5 분기와 조율.
- `skill.ts minModel stale 주석`: 주석 정정만(코드 무변경, §1.4).

### C5-2. DELETE analyze_market defaultModel plumbing (RV 도달불가 확인분)

`news/tools.ts:31` `ANALYZE_MARKET_FALLBACK_MODEL` + `registerAnalyzeMarketTool` 의 defaultModel 분기(108,165) + `news/index.ts:37,108` `defaultModel` config 필드/전달. **`analyzeMarket` 함수·`AnalyzeRunner`·schema 불변.**

- **HOLD 분기:** analyze_market 도구가 실제 live 호출 경로 있으면 보류·기록.
- 검증: `pnpm build`

### C5-3. 주석 정정 + ROUTE_INTENTS(M-A-5 분기 따라)

- skill.ts minModel stale 주석 정정.
- M-A-5 (b) 선택 시: route-task.ts:59 도달불가 정리. (a) 선택 시 무변경.
- 검증: `pnpm build`

### C5-G. 밀스톤 C5 검증

- 전체 게이트 **G**.
- 커밋: `refactor(phase44): remove dead analyze_market model plumbing`

---

# C6 — gateway

> plan §2 C6: OpenAI-compat 미구현 stub(flag off)·배럴 over-export·stale 'main 참조' 주석.
> REPORT B:111,112,113 + keep-but-noted(adaptResponse/adaptStreamChunk).

### C6-1. RV — gateway 후보 재검증

- **OpenAI-compat(B:113):** `adaptRequest 반환값`/`handleChatCompletions`/`mapModelId`(openai-compat/router.ts) — 결과 폐기(TODO), flag off + stub. **★ REPORT keep-but-noted: `adaptResponse`/`adaptStreamChunk` 는 보존**(OpenAI-compat 토대 — 단 결정§0 = 스캐폴드 삭제). **router.ts 가 flag off 로 어디서도 라우팅 안 되는지 RV.** OpenAI-compat 전체가 미배선이면 결정§0 따라 제거 가능하나, **이는 "별 phase" 로 REPORT 가 분류**(B:113) → **phase45 분리 권고**(아래 §초과 권고). C6 에서는 배럴/주석만 안전 처리.
- 배럴 over-export(B:111,112): `registerAgentMethods`/`registerAgentRunsMethods`/`registerMemoryMethods`/`AgentRpcDeps`/`AgentInfo`(index.ts:9-17) — server 통합테스트만 소비. `hasRequiredAuth` 외 9(index.ts:44-83) 내부 live·외부 0. **배럴 다이어트(저우선) — 정의 불변, export 만.**
- stale 'main 참조' 주석(index.ts:9-17 근처): 정정만.

### C6-2. 배럴 다이어트 + 'main 참조' 주석 정정

외부 0 확인된 배럴 export 제거(정의·내부 호출 불변) + stale 주석 정정. **OpenAI-compat router stub 삭제는 보류 → phase45**(REPORT "별 phase", 범위 큼).

- 검증: `pnpm build`

### C6-G. 밀스톤 C6 검증

- 전체 게이트 **G**.
- 커밋: `refactor(phase44): trim gateway barrel over-exports, fix stale comments`

---

# C7 — server (★ 플러그인 슬롯 최위험)

> plan §2 C7: `services/{hooks,security,daemon}`·**플러그인 슬롯 reader**·`DefaultPipelineObserver`·`channels/chat-type`·배럴 dead(services/plugins/cli/auto-reply index)·summarizer/tokenCounter plumbing·`*_SKILL_METADATA` orphan(P2 try/catch dedup·`_req`).
> REPORT A:83-90 + B:118 + E:158,159,160 + §5.7,5.8.

### C7-1. RV — server 후보 재검증 (★ 플러그인 슬롯·services 분별)

- **services 분별(★중요):** `server/src/services/` 에는 **live 파일 공존** — `brokerage-sync-service.ts`(main.ts brokerageDeps 소비 live)·`news-memorizer.ts`(RV 확인). **삭제 대상 = `services/{hooks,security,daemon}/` 서브디렉터리 + `services/index.ts` 배럴만.** brokerage-sync/news-memorizer 불변.
  - `services/hooks/*`(A:84): prod 0(배럴 경유 0), test only.
  - `services/security/*`(A:85): audit+redaction, observability redactPII 중복.
  - `services/daemon/systemd.ts`(A:86): self+배럴, **테스트조차 없음**(가장 명백).
- **★ 플러그인 슬롯(plan §3 최위험 — REPORT B:118):** `loadPlugins`(plugins/loader.ts) 는 **skills.ts:289 에서 LIVE-WIRED.** loader 내부:
  - **MCP 도구 경로 LIVE:** Stage 5 `manifest.mcpServers` → `createMCPClient`/`bridgeMCPTools`/`registerMCPTools`(loader.ts:226-252) = 실효(ToolRegistry 에 도구 등록). **삭제 절대 금지.**
  - **슬롯 writer LIVE 호출되나 reader dead:** `registerToSlot`(loader.ts:106-127,140,255,286) 가 channels/hooks/services/commands/routes/diagnostics/plugins 에 write. `getSlot`(reader) 역참조 0 = write-only scaffold(REPORT B:118 "registerToSlot live(9곳)·getSlot 역참조 0").
  - **결론:** `loadPlugins`/`createPluginBuildApi`/`registerToSlot`/MCP bridge 는 **live → 삭제 금지.** 삭제 가능 후보 = **`getSlot`/`getPluginRegistry` reader + `createHookRunner`/`bridgeHooksToEventBus`(hooks.ts/event-bridge.ts) + `PluginExports`/`loadPluginModule` export(loader.ts:24,70,298 TODO 마킹분)** = reader/hook 절반. **단 `registerToSlot` 가 write 하는 슬롯의 reader 를 지우면 write 가 무의미해지나 loader 가 write 호출을 멈출 순 없음**(코드 구조상 register 가 createPluginBuildApi 경유 호출). → **이 영역은 HOLD 우선**: reader 만 지우고 writer 남기면 "쓰지만 안 읽는" 코드가 남아 어정쩡. **REPORT "MCP 도구 경로만 실효" 를 RV 로 재확인하고, getSlot/reader 가 정말 0 소비면 reader+hook scaffold 제거, loadPlugins/MCP/registerToSlot 는 보존.** 모호하면 슬롯 전체 보류·기록(plan §3 "live 면 보류").
- **DefaultPipelineObserver(A:83):** auto-reply/observer.ts:25, runtime.ts 미주입 → 비-self·비-test 0 RV.
- **channels/chat-type(A:88):** `normalizeChatType`/`isDirect`/`isMultiUser`. session-key 직접 처리 → prod 0.
- **channels/registry(A:89):** `getChannelDock`/`hasChannelDock`/`resetChannelRegistry` test-only.
- **배럴 dead(A:87,90):** `services/index`/`plugins/index`/`cli/index`/`auto-reply/index.ts` — import 0(직접 경로 import). **단 plugins/index.ts 는 loadPlugins re-export 포함** → plugins/index 배럴 삭제 시 loadPlugins 직접 경로(skills.ts:34 `../plugins/loader.js`) 이미 직접 import → 배럴만 dead. RV 확인.
- **summarizer/tokenCounter plumbing(E:158,159):** auto-reply/pipeline.ts:67,69,344,345 + pipeline-context.ts:60,62. set 0(phase41 제거), executeStage 미참조 = 완전 dead 통로. **plan 은 agent/context 만 명시했으나 REPORT net-new → 동반 추적**(C4 압축과 짝). RV 후 제거.
- **`*_SKILL_METADATA` orphan(E:160):** main.ts:24-28,127-130 + skills metadata. **★ phase43 라우터는 머지됨(routerHelper 제거 완료) → minModel reader(routing.ts) 도 이미 제거됐는지 RV.** REPORT 는 phase42 시점(C cascade 대기) 기준이나 phase43 머지로 구 routing 삭제됐을 수 있음 → **main.ts 현행 재-Read 후 `*_SKILL_METADATA` import 가 정말 orphan 인지 확인.** orphan 이면 import + minModel/reason 필드 동반 제거.
- **P2 try/catch dedup·`_req`(REPORT §5.7 + phase43 review P1):** dispatch.ts dispatchPortfolioCalc `req` 미사용 파라미터(phase43 review P1) + try/catch 4회 반복. **plan §2 C7 가 명시 안 함(phase43 review 이연분).** ★ **조기 추상화 주의(§2):** 헬퍼 추출은 M-A (b) intent 확장 시에만 정당 — dead-code sweep 범위 아님. `_req` 미사용 파라미터는 lint 0 통과(blocker 아님) → **C7 에서 제거 금지(범위 밖, phase43 review 가 "M4 시 정리" 로 이연).** 본 todo 는 try/catch dedup·`_req` 를 **C7 비대상**으로 명시(범위 확장 차단).

### C7-2. DELETE services/{hooks,security,daemon} + 배럴

서브디렉터리 3 + `services/index.ts` 배럴(hooks/security/daemon export 분) + 테스트(hooks/security 만, daemon 무테스트). **brokerage-sync-service.ts·news-memorizer.ts·이들 배럴 export 불변.**

- 검증: `pnpm build`

### C7-3. DELETE DefaultPipelineObserver + channels dead + 배럴 dead

- `auto-reply/observer.ts:25` `DefaultPipelineObserver`(RV 0 확인분).
- `channels/chat-type.ts` 3함수 + `channels/registry.ts` 3 test-only 함수.
- `cli/index`·`auto-reply/index.ts`·`plugins/index`(loadPlugins 직접 import 확인 후) 배럴 dead.
- 검증: `pnpm build`

### C7-4. DELETE summarizer/tokenCounter plumbing + \*\_SKILL_METADATA orphan(RV 확인분)

- pipeline.ts:67,69,344,345 + pipeline-context.ts:60,62 plumbing(set 0 확인분).
- main.ts:24-28,127-130 `*_SKILL_METADATA` import + minModel/reason 필드 — **현행 재-Read 후 orphan 확인분만**(phase43 머지로 이미 제거됐으면 skip).
- 검증: `pnpm build`

### C7-5. 플러그인 슬롯 reader/hook scaffold (★ RV 통과 + 모호 시 보류)

C7-1 RV 결과 `getSlot`/reader·`createHookRunner`/`bridgeHooksToEventBus`/`PluginExports`/`loadPluginModule` export 가 비-self·비-test 0 확인 시만 제거. **`loadPlugins`/`createPluginBuildApi`/`registerToSlot`/MCP bridge 절대 보존.** 모호하면 **슬롯 전체 보류 → holds.md + review**(plan §3 명시).

- 검증: `pnpm build`

### C7-G. 밀스톤 C7 검증

- 전체 게이트 **G**.
- 커밋: `refactor(phase44): remove dead server (services/observer/channels/plumbing)` (슬롯 처리 결과 본문에 명시).

---

# C8 — clients (web + channel-discord)

> plan §2 C8: web 관찰성 UI(`renderTraceView`/`renderAuditView` + `createAgentClient`/`createTraceClient`/`createAuditClient`, ~220 LOC)·channel-discord 승인/embeds/포트 dead-path.
> REPORT A:91-97 + B:114,115.

### C8-1. RV — clients 후보 재검증

- **web(A:96,97):** `renderTraceView`(views/trace-view.ts, 128 LOC)·`renderAuditView`(views/audit-view.ts, 95 LOC) rg 소비 0. `createAgentClient`/`createTraceClient`/`createAuditClient`(app-gateway.ts:405,434,477) 정의 1곳·소비 0. **★ trace/audit RPC 는 gateway live**(REPORT A:96) — 삭제 대상 = web UI 렌더러/클라이언트 팩토리만, gateway RPC 불변. web import 0(정적 서빙)이라 cascade 위험 낮음.
- **channel-discord(A:91-95 + B:114,115):**
  - `buildErrorEmbed`(embeds.ts:84) 비-self·비-test 0.
  - `buildApprovalRow`/`waitForApproval`/`ApprovalButtonData`(buttons.ts + types.ts:34) 비-test 0(produce 부재).
  - `FinanceServicePort`/`AlertStoragePort`(types.ts:19,25) 구현/주입 0.
  - `SlashCommand`/`DiscordAccount`(index.ts:1) 외부 소비 0 — **★ `DiscordAccount`/`DiscordAccountSchema` 는 main.ts:11,134 LIVE** → 혼동 금지. index.ts 배럴의 `SlashCommand` 만 dead 가능, `DiscordAccount` 보존. RV 정밀.
  - `config 필드 6`(config.ts:8-13) prod read 0(sender 하드코딩).
  - `buildMarketEmbed`/`buildNewsEmbed`/`buildAlertEmbed`(B:114) 소비처 1이나 deps 미주입 dead-path — **REPORT "보존, 도달불가 표시"** → 결정§0(스캐폴드 삭제) vs REPORT 보존 권고 충돌 → **RV 후 dead-path 확정 시 제거, 모호 시 보류.**
  - `setupApprovalHandler`/`CommandDeps`(B:115) handler 등록되나 produce dead → 승인 클러스터 동반.

### C8-2. DELETE web 관찰성 UI + 클라이언트 팩토리

`views/trace-view.ts`·`views/audit-view.ts` 파일 + `app-gateway.ts:405,434,477` 3 팩토리 + 호출 라우팅(있으면). gateway trace/audit RPC 불변.

- 검증: `pnpm --filter @finclaw/web build`

### C8-3. DELETE channel-discord 승인/embeds/포트 dead-path

RV 통과분: `buildErrorEmbed`·승인 클러스터(`buildApprovalRow`/`waitForApproval`/`ApprovalButtonData`/`setupApprovalHandler`/`CommandDeps`)·미배선 포트(`FinanceServicePort`/`AlertStoragePort`)·config 6필드·`SlashCommand` 배럴. **`DiscordAccount`/`DiscordAccountSchema`/`DiscordAdapter`·live embeds 경로 보존.** market/news/alert embeds 는 dead-path 확정 시만.

- 검증: `pnpm --filter @finclaw/channel-discord build`

### C8-G. 밀스톤 C8 검증

- 전체 게이트 **G**.
- 커밋: `refactor(phase44): remove dead clients (web observability UI, discord dead-paths)`

---

# 최종 검증

- 전체 게이트 **G** (전 패키지 `tsc --build` + vitest 회귀 0).
- 보존 불변 회귀 0 확인: 메모리 RAG·cron·alerts live·route_task·키없이부팅.
- (선택) 실 키 부팅 smoke: gateway listening + Discord 온라인 + .env 자동 로드(M-B) + route_task 노출.
- review.md = `finclaw-phase-finalize` 자동 연쇄(승인 후 plans/phase44/review.md).

# 롤백

각 밀스톤 독립 커밋 → `git revert {커밋}` 단계 롤백. C 시리즈는 바텀업이라 상위 C revert 가 하위에 영향 적음(역순 revert 권장: C8→C1).

---

# phase45 분할 권고 (plan §3 분량 — 44 초과 시)

> plan §3: "8 서브밀스톤 + M-A/M-B. phase44 초과 시 C5~C8 일부를 phase45 로."

**phase44 코어(필수, 회귀 위험·latent bug):** M-A · M-B · C1(types cascade) · C2 · C3(+M-D latent bug) · C4. 여기까지가 "회귀 의심 4종 의도성 확정 + latent bug 해소 + 최고위험 cascade" 로 plan §6 시급도 1~4 핵심.

**phase45 이월 권고(저위험·범위 큼):**

1. **M-A-5 (b) intent 동적화** — `registerRouteTaskTool` 시그니처 변경(server→skills-general 주입)은 표면 크고 C5 ROUTE_INTENTS 와 얽힘. M-A 는 (a) 토대로 닫고 (b) 는 45.
2. **C6 OpenAI-compat router stub 삭제** — REPORT B:113 "별 phase" 명시. C6 에서는 배럴/주석만, stub 제거는 45.
3. **C7 플러그인 슬롯 reader/hook scaffold(C7-5)** — plan §3 최위험 false-positive 구역. MCP 도구 경로 live 확정·reader 0 재확인이 길면 45 분리(보류가 기본값).
4. **C8 channel-discord embeds dead-path** — REPORT "보존 권고" vs 결정§0 충돌, 모호분은 45.
5. **C5 ROUTE_INTENTS.includes 도달불가 정리** — M-A-5 (b) 와 동반이라 (b) 가 45 면 함께 45.

**분할 기준선:** C4 종료 후 진행 속도·게이트 안정성 보고 → C5~C8 일괄 진행 vs 45 분할 사용자 판단. 저위험 배럴 다이어트(C2-5/C6-2)는 phase44 잔여 시간에 흡수, 고위험(C7-5)·범위 큰(M-A-5b/C6 stub) 것 우선 이월.
