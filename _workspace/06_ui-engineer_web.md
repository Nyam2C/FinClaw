# 밀스톤 E — Web UI: 거래 이력, 기억 관리, 에이전트 실행 이력

작업자: ui-engineer
브랜치: `feature/memory-and-transactions`
산출 일시: 2026-04-28

## 결정 사항

- **자동 갱신 메커니즘: 옵션 A 채택** — `packages/server/src/gateway/ws/connection.ts:47` 의 `subscriptions` 초기값을 `new Set(['portfolio.changed'])` 로 변경. 모든 WebSocket 클라이언트가 연결 즉시 portfolio.changed 채널을 자동 구독한다. 추가 RPC(`system.subscribe`) 없이 1줄 변경으로 거래 변경의 fan-out 이 모든 세션(채팅·외부 RPC 포함)에 도달.
- 토스트는 별도 컴포넌트 신설 없이 각 view 안에서 `<div role="alert">` 로 처리. 기존 alerts-view 의 `.error` 패턴과 동일.
- transaction-form 은 `<dialog>` 대신 `position: fixed` 오버레이. shadow DOM 안에서 다루기 쉬움.

## 변경 파일

| 파일                                             | 종류               | 변경 요약                                                                                                                                                                         |
| ------------------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/server/src/gateway/ws/connection.ts`   | 수정 (1줄)         | `subscriptions` 초기값에 `'portfolio.changed'` 자동 등록                                                                                                                          |
| `packages/web/src/app-gateway.ts`                | 확장 (+~150 LOC)   | `Transaction`, `UpdatedHolding`, `Memory`, `MemorySearchHit`, `AgentRunSummary`, `AgentRunFull` 타입 + `FinanceClient` transaction.\* 메서드 + `MemoryClient` + `AgentRunsClient` |
| `packages/web/src/views/portfolio-view.ts`       | 재작성 (+~200 LOC) | "보유 종목"/"거래 이력" 탭 분리, 기존 holdings 테이블 보존(외과적), 거래 이력 테이블 + 추가 모달 + 삭제(confirm) + portfolio.changed 자동 갱신 + 5초 deleteWaiting fallback       |
| `packages/web/src/views/transaction-form.ts`     | 신설 (~270 LOC)    | in-place 모달, 클라이언트 1차 검증, 실패 시 입력 보존, `transaction-added`/`close` CustomEvent                                                                                    |
| `packages/web/src/views/settings-view.ts`        | 재작성 (~340 LOC)  | 내 기억 (type 필터 + 삭제) + 에이전트 실행 이력 (행 클릭 시 expand로 detail) + 라우팅 통계 placeholder                                                                            |
| `packages/web/src/main.ts`                       | 수정 (+1줄)        | `transaction-form.js` side-effect import                                                                                                                                          |
| `packages/web/src/app.ts`                        | 수정 (+1줄)        | `<settings-view>` 에 `.gateway` 바인딩                                                                                                                                            |
| `packages/web/src/__tests__/app-gateway.test.ts` | 확장 (+~140 LOC)   | 6 신규 테스트: transactionAdd/Delete, memory.list/delete, agent.runs.list/get RPC wrapper                                                                                         |

## RPC 매핑

UI → 게이트웨이 호출 라우팅:

- portfolio-view → `finance.portfolio.get`, `finance.transaction.list`, `finance.transaction.delete`
- transaction-form → `finance.transaction.add`
- settings-view (memories) → `memory.list`, `memory.delete`
- settings-view (runs) → `agent.runs.list`, `agent.runs.get`

알림 수신 (fan-out): `notification.portfolio.changed` (params 의 `data` 필드에 `{portfolioId, updatedAt, reason, transactionId}`).

## 자동 갱신 흐름

```
사용자 A: 채팅에서 "AAPL 10주 매수" 명령
  → MemoryCaptureStage 거치며 finance.transaction.add 호출
  → broadcaster.broadcastToChannel(connections, 'portfolio.changed', {portfolioId, reason, transactionId})
  → 자동 구독된 모든 WS 연결로 fan-out
사용자 A 의 Web 탭(다른 브라우저창 포함):
  → app-gateway.handleMessage → notificationHandlers fan-out
  → portfolio-view.notificationHandler 가 method='notification.portfolio.changed' 매칭 → load() 재호출
  → 새 holdings + transactions 즉시 표시
```

삭제 후 fallback: portfolio-view 의 `onDelete` 는 5초 안에 portfolio.changed 가 안 오면 deleteWaiting 토스트를 끄고 수동 load() 1회 강제 (broadcaster 미주입 환경에서도 데이터 반영).

## UI 구조

### portfolio-view

```
[Portfolio — 본명] [새로고침]
[ 보유 종목 | 거래 이력 ]   ← @state activeTab
└ holdings: 기존 테이블 (Symbol/수량/평균단가/통화) — 외과적으로 유지
└ transactions:
   [+ 거래 추가]
   ┌────────────────────────────────────┐
   │ 날짜 심볼 액션 수량 단가 금액 노트 [삭제] │
   └────────────────────────────────────┘
```

거래 추가 클릭 시 `<transaction-form>` 모달 오버레이.

### transaction-form (모달)

```
거래 추가                       [×]
┌────────────────────────────┐
│ 심볼 *      [AAPL          ]│
│ 액션 *  ▾   수량 *  [      ]│
│ 단가  *     수수료  [0     ]│  (* buy/sell 시)
│ 통화  ▾     거래일 * [today ]│
│ 노트       [...............]│
│                            │
│            [취소] [추가]    │
└────────────────────────────┘
```

검증: 심볼 필수, 수량>0, buy/sell 일 때 단가 필수, 수수료/단가 음수 거부, executedAt 파싱 가능.
실패 시 폼 상단에 빨간 토스트 + 입력값 그대로 보존.

### settings-view

```
Settings
┌─ 내 기억 ──────────────────────────────────┐
│ [type ▾ 전체/preference/fact/financial/summary] [새로고침] │
│ ┌────────────────────────────────────┐    │
│ │ 유형 내용 세션 생성일 [삭제]          │    │
│ └────────────────────────────────────┘    │
└────────────────────────────────────────────┘

┌─ 에이전트 실행 이력 ────────────────────────┐
│ [새로고침]                                   │
│ ┌────────────────────────────────────┐    │
│ │ 시각 Agent Role Model Duration ...   │    │  ← 행 클릭 시 expand
│ │   ▼ Prompt / Output / Error / ToolCalls / Metadata │
│ └────────────────────────────────────┘    │
└────────────────────────────────────────────┘

┌─ 라우팅 통계 ─────────────────────────────┐
│ 데이터 없음 (Phase 24+ 산출 가용 시)        │
└────────────────────────────────────────────┘
```

## 검증 결과

- `pnpm --filter @finclaw/web build` → ok (vite build 1.20s, 127.79 kB)
- `npx vitest run packages/web` → **31 passed (이전 25 + 신규 6)**
- `npx vitest run packages/server` → **591 passed** (connection.ts 1줄 변경 회귀 0)
- `pnpm typecheck` → ok (0 error)
- `pnpm lint` → 0 warnings, 0 errors (469 files, 126 rules)

## 수동 검증 시나리오 (사용자가 브라우저에서 확인)

1. **거래 추가 → 자동 반영**: Portfolio 탭 → 거래 이력 → "+ 거래 추가" → AAPL/buy/10/180/USD 입력 → 추가. 모달이 닫히고 거래 이력 테이블 + 보유 종목 테이블이 즉시 갱신되는지 확인.
2. **다른 채널 변경 자동 반영**: 한 브라우저 탭은 Web UI 의 거래 이력에 머물고, 다른 탭(또는 채팅)에서 거래를 추가/삭제 → 첫 탭이 자동으로 갱신되는지 확인 (옵션 A 자동 구독 검증).
3. **거래 삭제 두 단계 confirm**: 거래 이력에서 [삭제] 클릭 → confirm 다이얼로그 → 확인 → 행 사라지고 holdings 재계산. confirm 취소 시 변화 없음.
4. **거래 추가 검증 실패**: 빈 심볼 / 수량 0 / buy 인데 단가 미입력 시 빨간 토스트 + 입력값 보존 확인.
5. **기억 type 필터**: Settings → 내 기억 → type 드롭다운으로 preference/fact/financial/summary 변경 → 목록이 해당 type 만으로 필터되는지 확인. 삭제 버튼 confirm 후 행 제거 확인.
6. **에이전트 실행 이력 expand**: Settings → 에이전트 실행 이력 → 행 클릭 시 아래로 펼쳐지며 prompt/output 전체, toolCalls JSON, metadata 표시 확인. 다시 클릭 시 닫힘. error 가 있는 run 은 우측 status 가 빨간 "error" 배지.

## 다음 단계 노트

- 거래 수정(편집) UI 는 본 Phase 범위 외. 필요 시 transaction-form 의 prefill 모드를 추가하면 재사용 가능.
- 라우팅 통계 placeholder 는 Phase 24 산출(LLM 라우팅 결정 통계)이 RPC 로 노출되면 후속 작업으로 채울 수 있음.
- WebSocket 끊김 자동 재연결은 기존 `app-gateway` 의 `scheduleReconnect` 가 이미 처리 — 재구현 없음.
