# Todo Decomposition Guide — phase-todo-architect 컨벤션

기존 plans/phase16/22/26/28 의 todo.md 분석 결과 도출. plan.md 의 "무엇을" 을 코드 단위 "어떻게" 로 분해.

## 1. 최상위 구조

```markdown
# Phase {NN} Todo: {plan.md 제목}

> plan.md 의 밀스톤을 코드 단위로 분해.

---

## 사전 준비

### P-1. {준비 작업 제목}

...

## 밀스톤 A — {plan.md 가 정한 A 의 한 줄 목표}

### A1. {VERB} `{file-path}`

...

### A2. ...

### A{N}. 밀스톤 A 검증

(검증 명령 목록)

## 밀스톤 B — ...

(같은 구조)

## 최종 검증

## 정리 (필요 시)

## 롤백 절차
```

## 2. 밀스톤 매핑

plan.md 의 밀스톤 / 단계 → todo.md 의 `## 밀스톤 X` 1:1 매핑.

- plan.md 가 "Step 1, Step 2..." 형식이면 → 밀스톤 A, B, ... 로 변환 (영문 letter)
- plan.md 가 작아 밀스톤 분리 불필요 → `## 본 작업` 단일 섹션 + 안에 `### 1, 2, ...`
- plan.md 가 너무 큼 (200+ LOC 변경 예상) → 의미 단위로 1차 그룹핑 후 밀스톤 부여

각 밀스톤은 **독립 커밋 가능** 해야 함. 밀스톤 A 만 적용한 상태에서 typecheck 가 통과해야 함 (plan.md 가 의도적으로 의존 깨질 만한 단계를 포함하지 않는 한).

## 3. 단계 헤딩

```
### {Letter}{Num}. {VERB} `{file-path}` — {짧은 설명}
```

- Letter: 밀스톤 letter (A, B, ...)
- Num: 1 부터 시작
- VERB: `CREATE` / `EDIT` / `DELETE` / `RENAME`
- file-path: 프로젝트 루트 기준 (예: `packages/server/src/foo.ts`)
- 설명: 한 줄 (선택). 없어도 됨.

특수 단계:

- `### P-1`, `### P-2`: 사전 준비 (의존성, schema bump 등)
- `### T-1`, `### T-2`: 본 구현과 분리된 테스트 (보통은 밀스톤 안에 포함)
- `### {Letter}N. 밀스톤 {Letter} 검증`: 밀스톤 끝의 검증 단계

## 4. 코드 스니펫 작성

### CREATE 단계

전체 파일 내용:

````markdown
### A1. CREATE `packages/types/src/automation.ts`

```ts
// packages/types/src/automation.ts
// Phase {NN}: {짧은 컨텍스트}.

import type { AgentId } from './common.js';

export interface Schedule {
  readonly id: string;
  // ...
}
```

검증: `pnpm --filter @finclaw/types build`
````

- 첫 줄에 파일 경로 주석 (선택, 가독성)
- import 까지 포함 — implementer 가 그대로 적용
- `검증: ...` 명령 첨부 (가능한 경우)

### EDIT 단계

변경 부분만, 컨텍스트 3-5 줄:

````markdown
### A4. EDIT `packages/storage/src/index.ts` — re-export

```ts
// ... 기존 export ...
export { createSchedule, listSchedules, updateSchedule, deleteSchedule } from './schedules.js';
```

검증: `pnpm --filter @finclaw/storage build`
````

- `// ... 기존 ...` 표기로 변경 위치 명확화
- 큰 함수 변경 시 변경된 함수 전체 + 위아래 1-2 줄 컨텍스트
- 검증 명령 첨부

### DELETE 단계

```markdown
### B5. DELETE `packages/server/src/old-helper.ts`

삭제 대상: 전체 파일 (Phase {NN-1} 이후 미사용).

영향: `packages/server/src/main.ts` 의 import 1 줄 제거 — A6 단계에서 처리.

검증: `pnpm typecheck`
```

위치 / 영향 / 검증.

## 5. 밀스톤 검증 단계

각 밀스톤의 마지막 단계는 항상:

```markdown
### A7. 밀스톤 A 검증

다음을 모두 통과해야 다음 밀스톤으로 진입:

- `pnpm typecheck`
- `pnpm --filter @finclaw/storage test --run`
- `pnpm --filter @finclaw/storage build`
```

- 항상 `pnpm typecheck`
- 변경 영역의 unit test 또는 storage test
- 변경된 패키지의 build (project references 영향 확인)

밀스톤 끝에 lint 도 가능하지만 phase 끝 무렵 한 번이면 충분.

## 6. 최종 검증

```markdown
## 최종 검증

phase 전체 완료 후 다음 모두 통과:

- [ ] `pnpm typecheck`
- [ ] `pnpm test --run`
- [ ] `pnpm test:storage`
- [ ] `pnpm lint`
- [ ] `pnpm build`
- [ ] mock-only 격리: API 키 unset 상태에서 `pnpm test --run` 통과
- [ ] 마이그레이션 시뮬레이션 (storage 변경 시)
```

## 7. 롤백 절차

```markdown
## 롤백 절차

각 밀스톤이 독립 커밋 → 단계적 롤백:

- 밀스톤 D 롤백: `git revert {sha-D}` — UI 만 제거
- 밀스톤 C 롤백: `git revert {sha-D} {sha-C}` — UI + RPC 제거
- 전체 phase 롤백: `git revert {sha-A}..{sha-D}` 또는 phase 시작 SHA 로 reset

storage 마이그레이션이 포함된 phase 는 롤백 시 SCHEMA_VERSION 처리 별도 명시.
```

## 8. plan.md 가 모호할 때

plan.md 의 결정이 모호 / 누락 발견:

- 빈 자리 채우려고 자체 추론 X (CLAUDE.md §1)
- `_workspace/phase-execute/{phase}-questions.md` 작성:

```markdown
# Phase {NN} 결정 필요 항목

## Q1. 밀스톤 B 의 cron 라이브러리

- plan.md: "cron 5필드 파싱"
- 미명시: croner / cron-parser / 자체 구현 중 무엇?
- 추천: cron-parser (이미 의존성 가벼움, 검증된 라이브러리)
- 결정 후 진행

## Q2. ...
```

오케스트레이터로 SendMessage. 답변 받기 전 진행 X.

## 9. FinClaw 특이사항

분해 시 항상 고려:

- **workspace deps**: package 추가 시 `workspace:*` 사용
- **composite tsconfig**: 새 패키지 / 새 reference 추가 시 `tsconfig.json` references 갱신 필요
- **lefthook**: typecheck + format-check 가 pre-commit. 코드 작성 후 `pnpm format:fix` 단계 포함 권장
- **oxfmt**: package.json 의 키 순서까지 재정렬 → 직접 편집 후 format:fix 필수
- **mock-only**: 외부 API 의존 코드는 mock provider 가 표준
- **node:sqlite**: Node 22+ built-in. 타사 의존 X

## 10. 분해 품질 체크리스트

todo.md 초안 작성 후 self-check:

- [ ] 모든 밀스톤이 독립 커밋 가능
- [ ] 각 밀스톤 끝에 검증 단계
- [ ] 모든 CREATE 단계가 import 까지 포함된 실행 가능 코드
- [ ] EDIT 단계가 변경 위치를 명확히 표시
- [ ] plan.md 가 요구하지 않은 변경 없음 (CLAUDE.md §3)
- [ ] 외부 API 의존 테스트는 mock 사용
- [ ] 마이그레이션이 있으면 시뮬레이션 단계 포함
- [ ] 롤백 절차 명시
- [ ] 모호함은 questions.md 로 분리, 추측 X
