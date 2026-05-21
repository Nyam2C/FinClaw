# Phase 33 — 한투 KIS 잔고 동기화 + 뉴스 요약 메모리화 (FINAL)

> **이 phase 는 FinClaw 의 마지막 plan 이다.**
> Phase 33 종료 시점에서 사용자의 매일 시나리오(보유 종목 24h 뉴스 자동 요약)가 자동으로 굴러간다.
> 종료 후 1개월(2026-07 초) 사용 검증을 거쳐, 신규 phase 추가 없이 사용 기반 유지보수만 한다.

## Context

`_workspace/audit/SUMMARY.md` 의 매일 사용 시나리오(S-1: 매일 09:00 보유 종목 뉴스 요약 → Discord DM) 가 진짜 작동하려면 **두 개의 빠진 조각** 이 있다:

1. **보유 종목 데이터의 source of truth 부재** — 현재 `portfolio_holdings` 는 수동 입력 또는 거래 기반 재계산만 가능. 사용자가 매일 수동 입력하지 않는 한 stale 한 데이터로 뉴스 요약이 무의미해짐.
2. **뉴스 요약이 일회성** — `agent_runs` 에 저장은 되지만 RAG 검색 대상이 아님 (`memory-retrieval.ts` 가 `memories` 테이블만 조회). 결과적으로 "어제 NVDA 뉴스 vs 오늘" 같은 시간축 비교가 LLM 자동으로 불가능.

본 Phase 의 단일 목표: **사용자 본인의 한투 KIS 계좌를 source of truth 로 삼아 portfolio 를 자동 동기화하고, 매일 뉴스 요약을 자동으로 memories 에 적재하여 다음 대화에서 자동 회상되게 한다.** 두 작업이 함께 가야 시나리오가 의미를 갖는다.

### 사용자 컨텍스트 (Phase 33 진입 전 확정)

- **증권사**: 한투 KIS Open API 단일 — 모의투자/실전 둘 다 지원하나 실전 default
- **시장**: 한국 + 해외(미국) 주식 모두 지원 — KIS 는 두 endpoint 분리(domestic-stock / overseas-stock)
- **권한**: **read-only 만** — 잔고 조회 (`inquire-balance`) 만 사용. 매매 endpoint(주문/취소) 호출 금지. 메모리 원칙(`매매 실행 도구는 기본 넣지 말 것`) 유지
- **계좌**: 본인 1개 계좌 (CANO + ACNT_PRDT_CD 단일 쌍)
- **운영 환경**: 사용자 본인 맥북 단일 — 자동화(cron)는 **SDK 모드 전용**(`provider` 미지정/`anthropic-sdk`). Phase 32 의 CLI 모드는 tool_use 비활성이라 도구 기반 자동화와 비양립(인스펙션 보강 §B-0 참조). 비용 0(CLI)는 수동 대화 전용, 자동화 시간엔 SDK.
- **사용 시나리오**: 매일 09:00 KST cron → KIS 동기화 → 각 보유 종목 24h 뉴스 요약 → Discord DM → memories 자동 적재

### 사용자 결정 사항 (Phase 33 시작 전)

본 Phase 진입 전 다음 5 가지 정책 결정이 필요. 미결정 시 각 트랙 시작 직전 확정:

1. **충돌 해결 정책** — 사용자가 직접 add 한 transactions 와 KIS 가 가져온 holdings 가 충돌하는 경우. **확정(인스펙션 §B-5): `portfolio_holdings` 에 `source` 컬럼('kis'|'tx') 추가(v11→v12).** `recomputeHoldings` 는 `source='tx'` row 만 DELETE/재계산하고 KIS row 는 보존. KIS 가 잔고 source of truth, `transactions` 는 사용자 수동 입력 유지(KIS 체결 내역 미수집). (원래 plan 의 "덮어씀" 은 recomputeHoldings 가 KIS row 를 wipe 하는 충돌을 못 다룸 — source 컬럼 분리로 교정.)
2. **모의 vs 실전 도메인** — 본 plan 은 `KIS_ENV=prod|vts` config 키로 분기. 기본값 `prod`. 테스트 시 `vts` (모의) 로 안전하게 검증.
3. **메모리 폭증 정책** — 매일 N 종목 × 1년 = 365N 메모리. 본 plan 은 **`type='financial'` 메모리에 90일 이상 자동 archival** 정책 추가. archival 된 메모리는 RAG 검색 대상에서 제외하되 memories 테이블에는 유지(읽기 전용 원칙).
4. **뉴스 요약의 metadata 인덱싱** — 자동 적재되는 메모리에 `symbol`, `briefDate` 메타 필요. **확정(인스펙션 §B-1): `memories.metadata` JSON 에 `{kind:'news-brief', symbol, briefDate}` 적재.** memories 에 `tags` 컬럼이 없고 `metadata TEXT DEFAULT '{}'` 만 존재하므로, metadata 활용이 스키마 변경 0 의 실제 경로 (원래 "tags 활용" 은 부정확).
5. **KIS 토큰 갱신 주기** — Access token 24h 유효. 본 plan 은 cron 호출 직전에 토큰 만료 체크 후 자동 갱신, 갱신 실패 시 Discord 알림 + 해당 회차 skip(다음날 재시도).

### 사실 검증 (HIGH 신뢰도, 직접 코드 확인)

| 항목                           | 현재 상태                              | Phase 33 작업 위치                                                               | 검증 방식      |
| ------------------------------ | -------------------------------------- | -------------------------------------------------------------------------------- | -------------- |
| `portfolio_holdings` 자동 주입 | ❌ tool call (`portfolio.get`) 만 가능 | `packages/server/src/auto-reply/stages/memory-retrieval.ts` 확장 또는 별도 stage | 코드 직접 확인 |
| `transactions` 자동 주입       | ✅ 심볼 발화 시 최근 3건/심볼          | `memory-retrieval.ts:301-318`                                                    | 직접 인용      |
| `memories` 자동 회상           | ✅ 임계 0.65 + 신선도 + 상한 3         | `memory-retrieval.ts` 그대로 활용                                                | 직접 인용      |
| `agent_runs` RAG 검색          | ❌ 검색 대상 아님                      | 본 plan 은 agent_runs 검색 확장 대신 **출력을 memories 로 자동 적재** 채택       | 우회 결정      |
| KIS API 어댑터                 | 신규                                   | `packages/skills-finance/src/brokerage/kis/` (신규)                              | 신규           |
| 매일 뉴스 cron                 | ✅ Phase 28 자동화                     | `packages/server/src/automation/scheduler.ts` (기존 활용)                        | 기존           |
| Cron 출력 hook                 | ❌ delivery 만, 후처리 없음            | `packages/server/src/automation/delivery.ts` 후속 hook 추가                      | 신규           |

---

## 인스펙션 보강 (post-phase32, base `567c07f`, 2026-05-21)

> Phase 31(Runtime Resilience) + Phase 32(Backend-as-CLI) 머지 후 본 plan 의 전제·경로·라인을 실코드로 재검증. **본 보강은 아래 밀스톤 본문의 어긋난 서술을 OVERRIDE 한다.** (검증 22항목: 일치 7 · 부분 4 · 어긋남 11, 치명 2 — 모두 아래 반영.) 사용자 결정 2건 확정(★#1 SDK 전용, ★#2 source 컬럼).

### ★ B-0. CLI 모드 비양립 — phase33 자동화는 SDK 모드 전용 (가장 중요, 확정)

- cron 은 chat 과 **동일한 단일 Runner/provider** 공유: `main.ts:476` `runnerFactory = new Runner({ provider: providerAdapter })` → `main.ts:626` SchedulerService 주입. provider = `createProviderAdapter({ kind: config.provider ?? 'anthropic-sdk' })`.
- cron 의 KIS 동기화·뉴스 요약은 **agent 의 tool call** (`scheduler.ts:231-257` exposedTools 주입 + `:300` collectToolCalls).
- **CLI 모드(`provider:'claude-cli'`)는 `tool_use` 미yield → skills-finance 전체 침묵 비활성** (phase32 review §6-1, P1-1; `main.ts` 부팅 `provider.cli_tools_disabled` 경고).
- **결정(사용자 확정): phase33 자동화는 SDK 모드 전제.** CLI(비용 0)는 수동 대화 전용, 자동화 시간엔 SDK. 두 모드는 동시 활성 불가.

### B-1. memories: `tags` 없음 → `metadata` JSON (결정 #4 교정)

- `memories` 에 `tags` 컬럼 없음, `metadata TEXT DEFAULT '{}'`(JSON)만 존재 (`storage/src/database.ts:53-61`; `MemoryEntry`도 `metadata?` 만, `types/src/storage.ts:32`).
- 적재: `{kind:'news-brief', symbol, briefDate}` 를 `metadata` 에. **스키마 변경 0 결론 유지** (수단만 tags→metadata).
- 저장 API: `createMemory` 헬퍼 **없음** → **`addMemoryWithEmbedding(db, entry, provider)`** (또는 `addMemory(db, entry)`). content sha256 dedup 자동. `sourceAgentRunId` 등 부가정보는 metadata 에.

### B-2. archival(결정 #3): 1차는 신선도 감쇠 (스키마 0)

- `archiveOlderThan` 헬퍼·`archived` 컬럼 모두 **없음**. retrieval 이 이미 `FRESHNESS_HALF_LIFE_DAYS=90` 반감기 적용(`memory-retrieval.ts:20`) → 90일 지난 financial 메모리 가중치 ≈37% 로 자연 강등, 임계 0.65 통과 어려움.
- **1차: 명시적 archival 없이 신선도 감쇠만.** 진짜 row 정리가 필요하면 `archived` 컬럼 = v11→v12 추가 (1개월 사용 후 폭증 실측 시 후속).

### B-3. 적재 hook 지점 (C1 재grounding)

- `memory-capture.ts` 는 **유저 발화 regex(fact/preference)만** — cron 출력 무관, financial 미지원. 재사용 X.
- cron 출력 후처리 hook 는 **이미 존재**: `scheduler.ts:411 onRunComplete` → `main.ts:640 deliveryHook`. news-memorizer 는 `onRunComplete` 분기에 추가 (delivery.ts 자체 수정 불요).
- schedule 식별: `Schedule` 에 `tags` 없음(`automation.ts:13`) → `schedule.tags?.includes('news-brief')` 불가. **name/prompt 컨벤션 매칭 또는 news-brief schedule id 화이트리스트.**

### B-4. KIS sync 의 schedule 형태 (B3 재설계)

- `schedules` 테이블에 `action`/`payload` 컬럼 **없음**. 컬럼=`(id,name,cron,agent_id,prompt,delivery_channel,delivery_target,enabled,timeout_ms,status,...)`(`database.ts:175-192`). 스케줄은 **agent prompt 실행**이지 RPC dispatch 아님. B3 의 `action:'rpc', payload:{method:...}` 는 **존재하지 않는 schedule 종류**.
- **확정: KIS sync 를 agent tool 로 등록** → 뉴스 cron prompt 가 동기화+요약을 한 번에 호출 (B-0 SDK 전제와 정합, 기존 scheduler 재사용).

### B-5. portfolio_holdings 충돌 — source 컬럼 분리 (결정 #1 확정)

- `portfolio_holdings(portfolio_id,symbol,quantity,average_cost)` 는 `recomputeHoldings`(transactions 파생)로만 채워지며 `addTransaction`/`update`/`delete` 가 매번 **전체 DELETE 후 재계산**(`transactions.ts:101`).
- **확정(사용자): `portfolio_holdings` 에 `source TEXT NOT NULL DEFAULT 'tx'`('kis'|'tx') 컬럼 추가 (v11→v12).** `recomputeHoldings` 는 `WHERE source='tx'` 만 DELETE/재계산 → KIS row 보존. KIS sync 는 `source='kis'` 로 직접 INSERT/replace.
- `replaceAllHoldings` 는 신규(`upsertHolding` 미존재 → 직접 INSERT). `holdings.ts` 파일 없음 → `transactions.ts` 확장 또는 신규 `holdings.ts`.
- `NormalizedHolding` 의 `market/currentPrice/currency/asOf` 는 현 holdings 컬럼에 없음 → **정규화 타입은 메모리 내부용**, DB 저장은 `(quantity,average_cost,source)`. 추가 필드가 정말 필요하면 v12 컬럼.

### B-6. config / secret 경로 (D1 교정)

- `config/src/loader.ts` **없음**. provider 시크릿은 **`server/src/main.ts` 의 `process.env`/`readKeyArray`** 패턴(`main.ts:351,384`). KIS 키(`KIS_APP_KEY`/`KIS_APP_SECRET`/`KIS_CANO`/`KIS_ACNT_PRDT_CD`/`KIS_ENV`)도 main.ts 에서 로드 + 미설정 시 brokerage 등록 skip (market/news 의 `:361-382` 패턴). config zod 추가는 패턴 이탈.
- `FINANCIAL_REDACT_PATTERNS`(`agent/src/agents/tools/result-guard.ts:26`)에 KIS Bearer 토큰 패턴 추가.

### B-7. 라인/버전 교정

- `SCHEMA_VERSION=11`(phase32). 신규 마이그레이션 = **v11→v12** (source 컬럼). 결정 #4 숫자 정확.
- transactions 자동 주입: `memory-retrieval.ts:301-318` → **실제 365-383**. memories 임계/신선도 컷 = 286-318. 임계 0.65/반감기 90/상한 3 = 정확.
- KIS 어댑터 패턴: `market/providers/*` + `provider-registry.ts` 구조, register→handle 반환→financeDeps 재배선. broadcaster `schedule.completed` 패턴(`delivery.ts:96`)으로 `brokerage.sync.completed` 추가 가능.

---

## 밀스톤 A — KIS Auth + Read-only Adapter

### 목표

한투 KIS Open API 의 read-only 4개 endpoint(토큰 발급 + 한국 잔고 + 해외 잔고 + 환율) 를 단일 인터페이스로 추상화. 매매 endpoint 는 코드에 존재하지 않게 한다(실수 호출 방지).

### 작업

**파일:**

- `packages/skills-finance/src/brokerage/kis/types.ts` (신규, ~80 LOC) — `KisCredentials`, `KisHoldings`, `KisError` 타입
- `packages/skills-finance/src/brokerage/kis/auth.ts` (신규, ~120 LOC) — Access token 발급/캐시/갱신
- `packages/skills-finance/src/brokerage/kis/client.ts` (신규, ~200 LOC) — fetch wrapper, hashkey 헤더, rate limit (token bucket: 실전 5/s, 모의 20/s)
- `packages/skills-finance/src/brokerage/kis/holdings.ts` (신규, ~150 LOC) — 한국 + 해외 잔고 조회 + 정규화
- `packages/skills-finance/src/brokerage/kis/index.ts` (신규, ~30 LOC) — public surface
- `packages/skills-finance/test/brokerage/kis/holdings.test.ts` (신규, mock 응답 fixture)

#### A1. Credentials 타입 + 환경변수

```ts
// types.ts
export interface KisCredentials {
  readonly env: 'prod' | 'vts';
  readonly appKey: string;
  readonly appSecret: string;
  readonly accountNo: string; // CANO (8자리)
  readonly accountProductCode: string; // ACNT_PRDT_CD (2자리, 보통 '01')
}
```

ENV 매핑:

- `KIS_ENV=prod|vts`
- `KIS_APP_KEY=...`
- `KIS_APP_SECRET=...`
- `KIS_ACCOUNT_NO=...` (CANO + ACNT_PRDT_CD 결합 또는 분리, plan 에서 분리 권장)
- `KIS_ACCOUNT_PRODUCT_CODE=01`

#### A2. Auth + Token Cache

- POST `/oauth2/tokenP` → access_token (24h 유효)
- 토큰 인메모리 캐시 + 만료 5분 전 사전 갱신
- 동시 요청 시 1회만 갱신 (mutex)

#### A3. Read-only Endpoint 4개

본 plan 은 다음 4개만 구현. 매매·정정·취소 endpoint 는 **코드에 존재하지 않게** 한다:

| Endpoint                                           | TR_ID                               | 용도               |
| -------------------------------------------------- | ----------------------------------- | ------------------ |
| `/oauth2/tokenP`                                   | n/a                                 | 토큰 발급          |
| `/uapi/domestic-stock/v1/trading/inquire-balance`  | TTTC8434R (실전) / VTTC8434R (모의) | 한국 잔고          |
| `/uapi/overseas-stock/v1/trading/inquire-balance`  | TTTS3012R (실전) / VTTS3012R (모의) | 해외 잔고          |
| `/uapi/domestic-stock/v1/quotations/inquire-price` | FHKST01010100                       | 한국 현재가 (옵션) |

#### A4. 정규화 (KIS 응답 → FinClaw 도메인)

KIS 응답 → `Holding[]` 변환. 한국/해외 응답 형식이 다르므로 두 normalizer.

```ts
interface NormalizedHolding {
  symbol: string;
  market: 'KR' | 'US';
  quantity: number;
  averagePrice: number;
  currentPrice: number | null;
  currency: 'KRW' | 'USD';
  asOf: number; // unix ms
}
```

#### A5. 테스트

- KIS 응답 fixture (실제 응답 구조 모방, 키는 placeholder) → mock fetch
- 한국/해외 정규화 검증
- 토큰 만료/갱신 시나리오
- Rate limit 초과 시 backoff
- **외부 API 키 없이 통과** (메모리 원칙)

### 완료 조건

- [ ] read-only 4 endpoint 만 client.ts 에 export. grep 으로 `order|cancel|modify` 없음 확인
- [ ] holdings.test.ts 통과 (mock 기반)
- [ ] vts(모의) 환경 수동 1회 실호출 성공 (배포 전 사용자 검증)

### 추정

3-4일 (test 포함)

---

## 밀스톤 B — Holdings Sync RPC + Cron 통합

### 목표

`brokerage.sync.run` RPC 추가 + scheduler 가 매일 09:00 KST 호출 가능하게 함. portfolio_holdings 를 KIS 응답으로 덮어씀(source of truth).

### 작업

**파일:**

- `packages/server/src/gateway/rpc/methods/brokerage.ts` (신규, ~100 LOC) — `brokerage.sync.run`, `brokerage.sync.dryRun`, `brokerage.account.info` (read-only)
- `packages/server/src/services/brokerage-sync-service.ts` (신규, ~150 LOC) — KIS 응답 → portfolio_holdings UPSERT
- `packages/types/src/gateway.ts` 확장 — Zod 스키마
- `packages/storage/src/holdings.ts` 확장 — `replaceAllHoldings(holdings)` 트랜잭션 메서드 (기존 `upsertHolding` 활용 + 누락 종목 cleanup)
- `packages/server/test/services/brokerage-sync-service.test.ts` (신규)

#### B1. RPC 시그니처

```ts
// brokerage.sync.run — 실제 KIS 호출 + DB 갱신
input: {} (현재 로그인 user 기준, 1인 사용자)
output: {
  syncedAt: number,
  holdingsCount: number,
  marketsScanned: ['KR' | 'US'],
  errors: { market: string, message: string }[]
}

// brokerage.sync.dryRun — KIS 호출하지만 DB 갱신 안 함 (검증용)
input: {}
output: { holdings: NormalizedHolding[], wouldChange: { added, updated, removed } }

// brokerage.account.info — 계좌 메타 (잔고 합계만)
input: {}
output: { totalKRW: number, asOf: number }
```

#### B2. 충돌 해결 (정책 결정 #1)

- `portfolio_holdings` 테이블: KIS 가 source of truth. `replaceAllHoldings` 가 KIS 응답에 없는 row 는 quantity=0 처리(또는 삭제 — 결정 필요, plan 권장: soft delete 위해 quantity=0 + `archivedAt` 컬럼 추가하지 말고, **그냥 row 삭제** — 마이그레이션 부담 없음)
- `transactions` 테이블: 사용자 수동 입력 그대로 유지. KIS 체결 내역은 본 phase 에서 가져오지 않음.
- 사용자가 수동으로 add 한 거래는 holdings 재계산에 영향 X (이 phase 에서)

#### B3. Scheduler 통합

기존 `schedules` 테이블에 prebuilt schedule 추가:

```sql
INSERT INTO schedules (id, name, cron, action, payload, enabled)
VALUES (
  'brokerage-daily-sync',
  '매일 잔고 동기화',
  '0 9 * * *',  -- 09:00 KST
  'rpc',
  '{"method":"brokerage.sync.run","params":{}}',
  1
);
```

사용자가 web UI(Phase 28 D 의 schedule form)에서 enable/disable 가능.

#### B4. WebSocket 이벤트

`brokerage.sync.completed` event broadcast → web UI 가 실시간 갱신 (Phase 28 의 WebSocket broadcaster 활용).

### 완료 조건

- [ ] dryRun → 응답 검증 → run 으로 실제 동기화 → web UI 의 portfolio-view 가 즉시 반영
- [ ] schedule 등록 시 매일 09:00 자동 동기화 (vts 환경 1주 검증)
- [ ] KIS 장애(403, timeout) 시 errors[] 로 보고하고 schedules.failure_count++ (Phase 28 의 자동 disable 로직 활용)

### 추정

2-3일

---

## 밀스톤 C — News Brief 자동 메모리화

### 목표

매일 cron 의 뉴스 요약 출력을 자동으로 `memories` 테이블에 `type='financial'` 로 적재. 다음 대화에서 같은 심볼 언급 시 자동 회상되어 시간축 비교 가능.

### 작업

**파일:**

- `packages/server/src/automation/post-delivery-hooks.ts` (신규, ~100 LOC) — delivery 완료 후 후처리 hook 등록
- `packages/server/src/services/news-memorizer.ts` (신규, ~120 LOC) — agent_runs 출력 → memories 변환·저장
- `packages/storage/src/memories.ts` 확장 — `archiveOlderThan(type, days)` 메서드 (정책 결정 #3)
- `packages/server/test/services/news-memorizer.test.ts` (신규)

#### C1. Post-delivery Hook

기존 `delivery.ts` (Phase 28 C) 가 schedule 결과를 Discord/Web 으로 발송한 후 추가 후처리:

```ts
// scheduler 가 schedule 완료 시 호출
async function onScheduleCompleted(run: AgentRun, schedule: Schedule) {
  if (schedule.tags?.includes('news-brief')) {
    await newsMemorizer.absorb(run, schedule);
  }
}
```

#### C2. News Memorizer 로직

```ts
class NewsMemorizer {
  async absorb(run: AgentRun, schedule: Schedule): Promise<void> {
    // 1. agent_runs.output 에서 심볼별 요약 섹션 추출
    //    (agent 가 정해진 포맷으로 출력하도록 prompt 강제)
    const sections = parseSymbolSections(run.output);

    // 2. 각 심볼당 1개 memory 생성
    for (const { symbol, summary, briefDate } of sections) {
      await createMemory(this.db, {
        type: 'financial',
        content: `[${briefDate}] ${symbol} 뉴스 요약: ${summary}`,
        tags: ['news-brief', symbol, briefDate], // 정책 #4: 기존 tags 활용
        sourceAgentRunId: run.id,
      });
    }

    // 3. 90일 초과 financial 메모리 archival (정책 #3)
    await archiveOlderThan(this.db, 'financial', 90);
  }
}
```

#### C3. Agent 출력 포맷 강제

뉴스 요약 cron 의 prompt 가 다음 포맷을 강제하도록 수정:

```
## NVDA (2026-05-04)
어제 대비 ... [요약]

## AAPL (2026-05-04)
...
```

`packages/agent/src/prompts/news-brief.ts` (신규 또는 기존 prompt 확장).

#### C4. 회상 검증

- 사용자가 다음 날 "NVDA 뉴스 어땠어?" 라고 발화
- `extractSymbols("NVDA 뉴스 어땠어?")` → `['NVDA']`
- memory-retrieval 의 hybrid 검색이 어제 적재된 `[2026-05-03] NVDA 뉴스 요약: ...` 를 찾음
- 신선도 가중치 (어제 = days=1, 가중치 ≈ 0.99) → 임계 0.65 통과
- system prompt 의 "사용자 배경지식" 섹션에 자동 주입

### 완료 조건

- [ ] 1주 cron 실행 후 memories 테이블에 7N 개 (N=종목 수) row 적재
- [ ] 다음 날 새 대화에서 심볼 언급 시 어제 요약 자동 회상 (수동 검증 1회)
- [ ] 90일 archival 동작 (단위 테스트)
- [ ] 메모리 폭증 안 함 — 90일 cap 으로 안정 상태

### 추정

3일

---

## 밀스톤 D — Secret 관리 + 에러 회복

### 목표

KIS credentials 안전 보관, 토큰 만료/장애 시 graceful 처리, 사용자에게 가시성 제공.

### 작업

**파일:**

- `packages/config/src/loader.ts` 확장 — KIS env 키들 추가, 미설정 시 brokerage 모듈 자동 비활성화
- `packages/server/src/services/brokerage-health.ts` (신규, ~80 LOC) — 토큰 상태, 마지막 sync 시간 트래킹
- `packages/server/src/gateway/rpc/methods/brokerage.ts` 확장 — `brokerage.health.get` 추가
- `packages/web/src/components/settings-view.ts` 확장 — Brokerage 섹션 (마지막 sync, 토큰 상태, 수동 sync 버튼)
- `.env.example` 갱신
- `README.md` 의 환경변수 섹션 갱신

#### D1. Secret Hygiene

- `KIS_APP_SECRET` 등은 `~/.config/finclaw/.env` 권장 경로 명시 (실수 commit 방지)
- log 출력 시 `FINANCIAL_REDACT_PATTERNS` 에 KIS 토큰 추가 — `Bearer eyJ...` 노출 차단
- `brokerage.account.info` 응답에서 `accountNo` 마스킹 (`12345***`)

#### D2. 에러 분류 + 회복

| 에러                  | 분류            | 회복                                        |
| --------------------- | --------------- | ------------------------------------------- |
| Token 만료            | recoverable     | 자동 재발급 + retry 1회                     |
| Rate limit (EGW00201) | recoverable     | exponential backoff (1s → 2s → 4s, max 3회) |
| 네트워크 timeout      | recoverable     | retry 1회                                   |
| 401/403 (인증 실패)   | non-recoverable | Discord 알림 + schedule disable             |
| 500/503 (서버 장애)   | recoverable     | 다음 cron 까지 skip                         |

#### D3. 사용자 가시성

Web settings-view 에 Brokerage 섹션:

- 마지막 동기화 시간
- 토큰 상태 (valid until: ...)
- 수동 sync 버튼
- 최근 5회 동기화 결과 (성공/실패)
- KIS 환경(prod/vts) 표시

### 완료 조건

- [ ] `.env` 미설정 시 server 정상 부팅 + brokerage 기능만 비활성 (log: "KIS not configured")
- [ ] 토큰 만료 시뮬레이션 → 자동 갱신 + sync 성공
- [ ] 401 시뮬레이션 → schedule disable + Discord 알림 1회

### 추정

2일

---

## 밀스톤 E — 7일 무중단 검증 (Finish Line)

### 목표

본 phase 의 finish line 정의: **7일 연속 매일 09:00 KST 자동 동기화 + 뉴스 요약 + Discord DM + 다음 날 회상까지 누락 0**.

### 검증 체크리스트

- [ ] D-7 ~ D-1: 매일 09:00 ± 5분 내 Discord DM 도착 (7/7)
- [ ] DM 내용: 보유 종목 N 개 모두 포함, 어제 대비 변화 언급
- [ ] D+1 ~ D+7: 새 대화에서 심볼 언급 시 어제 brief 자동 회상 (system prompt 의 "사용자 배경지식" 섹션 내 표시)
- [ ] portfolio-view (web) 의 holdings 가 KIS 응답과 일치
- [ ] memories 테이블 row 수: 시작 시점 + 7N 개 (N=종목 수)
- [ ] schedules.failure_count = 0
- [ ] WSL/맥북 sleep 없이 24/7 가동 (caffeinate 또는 launchd 설정 권장)

### 사용자 사전 작업 (Phase 33 시작 전 본인이 해야 할 일)

1. 한투 KIS OpenAPI 신청 (https://apiportal.koreainvestment.com) → app key/secret 발급
2. 모의투자 신청 (실전 검증 전 vts 로 안전하게 테스트)
3. .env 4개 키 설정 (`KIS_ENV`, `KIS_APP_KEY`, `KIS_APP_SECRET`, `KIS_ACCOUNT_NO`, `KIS_ACCOUNT_PRODUCT_CODE`)
4. 맥북 launchd 또는 docker-compose 로 24/7 가동 환경 준비

### 추정

검증 자체는 7일 (개발 작업 아님). 검증 중 버그 발견 시 트랙 재진입.

---

## 의도적 비대상 (이 phase 가 안 하는 것)

다음은 **본 phase 범위 외**. 미래에 필요해지면 별도 phase 로:

- **매매 실행** — order/cancel/modify endpoint 호출. 메모리 원칙 유지.
- **다른 증권사** — 미래에셋, 토스, Schwab, IBKR. 본 phase 는 한투 KIS 단일.
- **체결 내역(transactions) 자동 동기화** — KIS `inquire-period-trans` 는 호출하지 않음. transactions 는 사용자 수동 입력 유지.
- **실시간 시세 WebSocket** — KIS WS 는 사용 안 함. 매일 1회 batch 로 충분.
- **여러 계좌** — 본인 1개 계좌만.
- **세금/배당 자동 처리** — KIS 응답에 dividend 정보 있어도 본 phase 는 holdings 동기화만.
- **agent_runs 직접 RAG 검색** — 우회 결정(Memorizer 로 memories 화). 직접 검색은 더 큰 작업.

---

## Phase 33 = FINAL 약속

본 phase 종료 후 다음 1개월(2026-06-04 ~ 2026-07-04) 은 **신규 phase 추가 금지**. 매일 시나리오 검증 + 발견된 갭 기록만. 1개월 후 사용 데이터 기반으로 phase 34 추가 여부 결정.

> "만들기" 가 아니라 "쓰기" 가 다음 단계. 1개월 사용에서 진짜 필요한 것이 발견되면 그것이 Phase 34 의 진짜 명세가 된다. 발견되지 않으면 — 본 plan 이 **진짜 마지막** 이다.

### 완료 시점 예상 점수 (audit 기준)

| 영역                 | Phase 32 종료 후 (예상) | Phase 33 종료 후 (예상)              |
| -------------------- | ----------------------- | ------------------------------------ |
| Architecture         | 3.7                     | 3.8                                  |
| Runtime & Tools      | 3.8                     | 3.8                                  |
| Memory & Knowledge   | 3.7                     | **4.2** (시간축 회상 작동)           |
| Interface & Channels | 3.5                     | **3.8** (brokerage UI)               |
| **종합**             | 3.7                     | **3.9** (Production-grade 안정 진입) |

---

## 추정 합계

- 밀스톤 A: 3-4일
- 밀스톤 B: 2-3일
- 밀스톤 C: 3일
- 밀스톤 D: 2일
- 밀스톤 E: 7일 (검증, 개발 X)
- **개발 합계: 10-12일** (활동일 기준 1-2주 압축 가능, 본인 페이스 13커밋/활동일 고려 시 5-7 활동일)

검증 7일 포함 시 calendar time 으로 약 3주.
