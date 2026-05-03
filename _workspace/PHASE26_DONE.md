# Phase 26 — 기억 & 거래 시스템 완료

## 최종 상태

**모든 5개 밀스톤 PASS. 통합 검증 12/12 PASS.**

- 전체 테스트: **1470 unit + 109 storage + 31 web = 1610**, 회귀 0.
- typecheck/lint: 0 errors / 0 warnings.
- 외부 API 키 없이 통과 (mock-only).
- 감사 로그 추적 가능 (memory.injected JSON line).

## 밀스톤 산출물

| 밀스톤             | 산출물                                         |
| ------------------ | ---------------------------------------------- |
| A — transactions   | `_workspace/01_milestone_A_summary.md`         |
| B — memory capture | `_workspace/02_milestone_B_summary.md`         |
| C — RAG 주입       | `_workspace/03_milestone_C_summary.md`         |
| D — agent_runs     | `_workspace/04_milestone_D_summary.md`         |
| E — Web UI         | `_workspace/05_milestone_E_summary.md`         |
| 통합 검증          | `_workspace/qa_milestone_E_and_integration.md` |

## 3축 완성 (FinClaw 핵심 가치)

- **쓰는 것**: `finance.transaction.*`, `!finclaw remember`/패턴 5종 으로 거래·기억·선호 저장.
- **읽는 것**: `MemoryRetrievalStage` 가 발화마다 임계값 0.65 + 신선도 exp(-days/90) + 상한 3개로 system prompt 에 주입. 심볼 거래 동시 주입.
- **기억하는 것**: `agent.run` 결과가 `agent_runs` 테이블 + type='financial' memory 로 저장되어 다음 대화에서 RAG 매칭.

## 주요 결정 (오픈 질문 해결)

| 질문                      | 결정                                                     |
| ------------------------- | -------------------------------------------------------- |
| #1 Holdings 재계산        | 애플리케이션 레벨 `recomputeHoldings` (trigger X)        |
| #2 기억 TTL               | 영구 보존 + 신선도 가중치                                |
| #3 임베딩 프로바이더      | createEmbeddingProvider best-effort (키 없으면 FTS-only) |
| #4 다국어 임베딩          | hybrid 모드 권장 (FTS-only 한국어 회수 한계 있음)        |
| #5 거래 시세 자동 조회    | X — 사용자 직접 입력                                     |
| #6 Portfolio 다중         | 1개 default (Phase 27+)                                  |
| #7 agent_runs vs memories | 별도 테이블 + memory_id 링크 (FK ON DELETE SET NULL)     |

## SCHEMA 진화

- v3 → v4: transactions 테이블 + holdings synthetic 변환
- v4 → v5: agent_runs 테이블 + memory_id FK ON DELETE SET NULL

## 후속 보강 후보 (결함 아님)

- listTransactions from/to 필터 단위 테스트
- daysOld < 0 clamp 명시 단위 테스트
- "내 철학은" 등 한국어 변형 정규식 매칭 단위 테스트
- silent reply 시 capture 꼬리표 표시 정책 재검토
- routing 통계 placeholder → 실제 데이터 연동
