# 밀스톤 E 종합 산출물 — Web UI 거래 이력 + 기억 관리

## 결과: PASS (Phase 26 완료)

전체 1470 unit + 109 storage + 31 web = **1610 테스트 통과**. 회귀 0. mock-only 원칙 준수.

## 변경 파일

**서버 (자동 구독 1줄):**

- `packages/server/src/gateway/ws/connection.ts:47` — `subscriptions: new Set(['portfolio.changed'])`

**Web UI (ui-engineer):**

- `packages/web/src/app-gateway.ts` — Transaction/Memory/AgentRun 타입 + FinanceClient.transaction\* + MemoryClient + AgentRunsClient
- `packages/web/src/views/portfolio-view.ts` — 보유종목/거래이력 탭 + 거래 추가 모달 + portfolio.changed 자동 갱신
- `packages/web/src/views/transaction-form.ts` (신설) — in-place 모달 + 클라이언트 검증
- `packages/web/src/views/settings-view.ts` (재작성) — 기억 + 에이전트 실행 이력 + 라우팅 통계 placeholder
- `packages/web/src/main.ts` — transaction-form 등록
- `packages/web/src/app.ts` — settings-view gateway 바인딩
- `packages/web/src/__tests__/app-gateway.test.ts` — 신규 6 테스트

**QA (qa-engineer):**

- `packages/server/src/auto-reply/__tests__/agent-run-to-retrieval.boundary.storage.test.ts` (신설) — e2e 시나리오 5: agent.run → attach → retrieval 4계층 통합

## 핵심 결정

- **자동 갱신 옵션 A 채택**: `connection.ts:47` 1줄 변경으로 모든 WS 클라이언트가 portfolio.changed 자동 구독. RPC subscribe 메서드 신설 X.
- **transaction-form 은 in-place 모달**: 별도 라우트 X. dispatchEvent 로 부모 갱신.
- **5초 fallback**: portfolio.changed 미수신 시 수동 reload 안내 (delete 후).
- **portfolio-view 외과적 변경**: 기존 holdings 테이블 컬럼/렌더 그대로. 탭 분기만 추가.
- **settings-view 라우팅 통계 placeholder**: Phase 24 산출 가용 시 향후 표시.

## 통합 검증 결과 (Phase 26 완료 조건)

| 항목                             | 결과                  |
| -------------------------------- | --------------------- |
| pnpm test (전체)                 | 1470/1470             |
| pnpm test:storage                | 109/109               |
| pnpm typecheck (tsgo)            | 0 errors              |
| pnpm lint (oxlint)               | 0 warnings / 0 errors |
| 마이그레이션 v3→v4→v5 무결성     | PASS                  |
| 감사 로그 (memory.injected emit) | PASS                  |
| e2e 시나리오 6/6                 | 모두 PASS             |

## e2e 시나리오 검증 (plan.md line 371~377)

1. ✅ transaction.add → Portfolio 뷰 반영 (qa_milestone_A 경계면 통합)
2. ✅ !finclaw remember → memories 저장 (qa_milestone_B 경계면 통합)
3. ✅ "내 선호" → preference 주입 (qa_milestone_C 경계면 통합)
4. ✅ agent.run → agent_runs + memories (qa_milestone_D 경계면 통합)
5. ✅ 다음 대화 RAG 매칭 (신규 agent-run-to-retrieval.boundary.storage.test.ts)
6. ✅ memory.delete → 검색 제외 (qa_milestone_B + memory.test.ts)
