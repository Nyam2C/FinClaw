# review.md 템플릿

기존 plans/phase16/22/26/28 의 review.md 분석 결과 도출한 통합 골격. phase 마다 가감 가능.

## 표준 헤더

```markdown
# Phase {NN} Review: {plan.md 의 한 줄 제목}

> todo.md 기반 구현 코드 리뷰. 구현 완료 상태, 코드 품질 이슈, 리팩토링 사항을 기록한다.

base SHA: `{sha-short}` ↔ HEAD: `{sha-short}` (변경 LOC: +X / -Y)

---
```

## 표준 섹션

```markdown
## 1. 구현 사항 (TODO 일치도)

### {밀스톤 또는 단계 카테고리}

| 단계   | 파일                   | 상태      | 비고                      |
| ------ | ---------------------- | --------- | ------------------------- |
| P-1    | `packages/x/y.ts`      | ✅ 완료   | todo.md 코드와 일치       |
| Step 3 | `packages/a/b.ts`      | ⚠️ 편차   | import 경로만 다름 (사유) |
| T-2    | `packages/x/y.test.ts` | ❌ 미구현 | -                         |

(밀스톤마다 표 반복)

## 2. 자동화 검증 결과

| 명령                | 결과               | 비고                   |
| ------------------- | ------------------ | ---------------------- |
| `pnpm typecheck`    | ✅ PASS            | -                      |
| `pnpm test --run`   | ✅ N pass / 0 fail | -                      |
| `pnpm test:storage` | ✅ N pass / 0 fail | -                      |
| `pnpm lint`         | ⚠️ N warnings      | (위치 인용)            |
| `pnpm build`        | ✅ PASS            | -                      |
| mock-only 격리      | ✅ PASS            | API 키 unset 상태 통과 |

(실패 항목은 핵심 에러 인용)

## 3. 경계면 검증

### 3.1 RPC ↔ UI

- `{method}`: ✅ shape 일치
- `{method}`: ❌ 응답에 `recentTransactions` 추가됐으나 UI 미반영 (`packages/web/src/views/portfolio-view.ts:123`)

### 3.2 storage ↔ RPC

...

### 3.3 pipeline ↔ prompt

...

### 3.4 broadcaster ↔ subscriber

...

## 4. 리팩토링 사항

### P0 — 즉시 (병합 전)

1. **`packages/x/y.ts:42` — Zod 스키마 중복**
   - 문제: 동일 zod 스키마가 RPC method 와 UI form 양쪽에 중복 정의
   - 근거: 두 정의가 다음 phase 에서 갈라질 위험. P0
   - 제안: `packages/types/` 로 추출, 양쪽이 import

### P1 — 권장 (다음 phase 안에)

1. **`packages/server/src/main.ts` (LOC 448) 비대화**
   - ...

### P2 — 선택 (선호 차이)

1. ...

## 5. 범위 밖 발견 (참고)

> phase 의 plan.md 가 요구하지 않은 영역에서 발견된 사항. 삭제·수정 권장이 아니라 기록만.

- `packages/old-thing.ts:N` — 사용처 0 인 export. 다른 phase 정리 후보.
- ...

## 6. scope creep 의심 (사용자 확인)

> 현재 phase 의 plan.md 가 요구하지 않은 변경. 머지 전 사용자 판단 필요.

- {파일} 의 함수 시그니처 변경 — plan.md 는 신규 추가만 요구했으나 기존 함수도 수정됨
- ...

## 7. 위험 신호

> 즉시 의사결정 필요한 항목.

- {위험}

## 8. 다음 phase 후보 (제안)

- ...

## 9. 측정값

- 변경 파일 수: N
- 변경 LOC: +X / -Y
- 새 테스트 수: N
- 검토 소요: N분
- review-draft 생성 일시: YYYY-MM-DD

## 10. 권고 — 머지 가능 여부

**판정**: ✅ 머지 가능 / ⚠️ 조건부 (P0 처리 후) / ❌ 차단

조건:

- {조건 1}
- {조건 2}
```

## 가감 규칙

- todo.md 가 없는 phase → 섹션 1 은 plan.md 의 밀스톤 단위로만, 단계 표기 없이 prose 로 기록
- 마이그레이션 없음 → 섹션 2 의 "마이그레이션 시뮬레이션" 행 생략
- 사용자 수동 시나리오가 plan.md 에 명시 → 별도 `## 사용자 수동 테스트 시나리오` 섹션 추가 (phase26 패턴)
- 비교 표 / 지표가 phase 본질에 중요 → `## 측정값` 확장 (phase22 패턴)

## 머지 절차

`_workspace/phase-review/{phase}-review-draft.md` 작성 후:

1. 메인이 사용자에게 핵심 발견 3-5 줄 요약
2. 사용자 승인 → `Write` 으로 `plans/phase{NN}/review.md` 저장
3. 기존 review.md 가 있으면 덮어쓰기 X — 사용자가 수동 머지 결정
