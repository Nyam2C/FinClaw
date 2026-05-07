# Implementation Protocol — phase-implementer 실행 프로토콜

todo.md 의 단계를 코드로 옮기고 밀스톤마다 검증 + 커밋. 자체 판단 추가 변경 X.

## 1. 시작 절차

오케스트레이터로부터 받는 입력:

- phase 번호
- `plans/phase{NN}/todo.md` 경로 (사용자 승인된 것)
- 시작 단계 (`전체` / `밀스톤 X` / `{Letter}{Num}`)
- base SHA

확인:

1. todo.md 존재 + 읽기
2. 현재 브랜치가 phase 전용인지 (예: `feature/us-market-data`). main 이면 정지 + 보고.
3. base SHA 가 현재 브랜치 ancestor 인지 (`git merge-base` 확인). 아니면 정지.
4. workspace dirty 검사 — uncommitted 변경 있으면 정지 + 보고.

## 2. 단계 실행 루프

```
for milestone in todo.md 의 밀스톤 순서:
    if 시작 단계 < milestone: continue   # 부분 재실행 처리

    for step in milestone.steps:
        apply(step)                       # CREATE / EDIT / DELETE
        # 각 단계 직후 검증은 옵션 — 보통 밀스톤 끝까지 모아서

    run(milestone.검증 명령들)
    if 검증 FAIL:
        report(SendMessage 오케스트레이터)
        정지
    else:
        format_fix()                      # pnpm format:fix (oxfmt + package.json 정렬)
        commit(milestone)                 # git add + commit
        log(implementer-log.md)
```

## 3. 단계 적용 규칙

### CREATE

```
파일 경로 = todo.md 의 헤딩에서 추출
내용 = todo.md 의 코드블록 그대로
도구 = Write
```

- 코드블록 시작/끝 줄 (```ts) 은 제외하고 본문만
- 첫 줄에 파일 경로 주석 (`// packages/x/y.ts`) 이 있으면 그대로
- 변수명·주석·공백 변경 X

### EDIT

```
파일 경로 = todo.md 헤딩에서 추출
변경 위치 = todo.md 의 컨텍스트 (`// ... 기존 ...` 표기)
변경 내용 = 코드블록 안의 변경 부분
도구 = Edit
```

- `Edit` 사용 시 old_string 은 todo.md 가 보여주는 변경 전 코드, new_string 은 변경 후
- todo.md 가 EDIT 단계인데 코드블록이 변경 후 전체만 보여주면 → 파일을 Read 해서 변경 위치 직접 확인 후 Edit
- 일반화 X — todo.md 가 명시한 줄만 변경

### DELETE

```
도구 = Edit (파일 일부 삭제) 또는 Bash rm (파일 전체)
```

- todo.md 가 "전체 파일" 이라 명시 → `git rm <file>` 또는 OS rm
- "함수 N 만" 이라 명시 → Edit 으로 해당 함수만 제거
- 자기 변경으로 미사용이 된 import 만 정리. 무관한 dead code 발견 시 implementer-log 에 기록만, 삭제 X.

### RENAME

```
도구 = Bash git mv
```

- import 경로 갱신은 todo.md 가 별도 EDIT 단계로 명시해야 함

## 4. 밀스톤 검증

todo.md 의 `### {Letter}N. 밀스톤 {Letter} 검증` 단계가 명시한 명령들을 모두 실행:

```bash
export PATH="$HOME/.nvm/versions/node/v22.21.1/bin:$PATH"   # 환경에 따라
pnpm typecheck                                               # 항상
pnpm test --run                                              # 코드 변경 시
pnpm test:storage                                            # storage 변경 시
pnpm --filter @finclaw/x build                               # 단일 패키지 검증
```

각 명령:

- 종료 코드 0 = PASS
- 비-0 = FAIL → 정지 + SendMessage

이전 명령 PASS 여도 다음 명령 fail 가능 (typecheck PASS / test FAIL 등). 모두 통과해야 다음 단계.

옵션 명령 (todo.md 가 명시 안 했으면 생략):

- `pnpm lint` — 보통 phase 끝 무렵 한 번
- `pnpm test:e2e`, `pnpm test:live` — 사용자 명시 요청 시
- `pnpm build` — 패키지 의존 영향 큰 phase

## 5. 커밋

검증 PASS 후:

```bash
pnpm format:fix                              # oxfmt + package.json 정렬
git add {todo.md 단계가 건드린 파일들}        # 명시적 add (전체 add X)
git commit -m "feat(phase{NN}): 밀스톤 {Letter} — {제목}

- {step1 요약 한 줄}
- {step2 요약 한 줄}
...

Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>"
```

### 커밋 메시지 규칙

- conventional 형식: `feat(...)`, `fix(...)`, `refactor(...)`, `chore(...)`, `docs(...)`
- subject 70 자 이내
- 한글 subject 시도 → lefthook conventional 실패면 영문으로 재시도 (CLAUDE.md feedback)
- body 는 단계별 한 줄 요약 (todo.md 헤딩 그대로)
- Co-Authored-By 끝줄

### `git add` 범위

- todo.md 의 단계가 명시한 파일만 add
- `git add -A` X — 무관한 변경 휩쓸릴 위험
- format:fix 가 만든 변경은 add OK (의도된 형식 변경)
- 자기 변경으로 발생한 신규 .tsbuildinfo / dist 는 .gitignore 가 처리 — add 안 됨

### lefthook 실패 처리

- `pre-commit` 의 typecheck 실패 → 검증 단계에서 이미 잡혔어야 함. 그래도 발생 시 정지 + 보고.
- `pre-commit` 의 format-check 실패 → format:fix 가 누락. 한 번 더 실행 후 재시도.
- `commit-msg` 의 conventional 실패 → 한글 subject 가 일반적 원인. ASCII subject 로 재시도.
- 3 회 실패 시 정지 + 보고. `--no-verify` 사용 X (CLAUDE.md 가이드).

## 6. 부분 재실행

오케스트레이터가 SendMessage 로 시작 지점 지정:

- "전체" → 처음부터
- "밀스톤 C 부터" → A, B 는 건너뛰기 (이전 커밋 보존)
- "C3 부터" → C1, C2 는 건너뛰기

부분 재실행 시 주의:

- 이전 단계가 만든 파일 / 함수에 의존하는 단계 → 의존 깨질 위험
- typecheck 가 base 시점부터 통과해야 함 — 첫 검증에서 fail 면 base SHA 가 잘못됐거나 이전 단계 누락
- implementer-log 가 이미 있으면 이어서 기록 (기존 부분 보존)

## 7. 기록 (implementer-log)

`_workspace/phase-execute/{phase}-implementer-log.md`

```markdown
# Phase {NN} Implementer Log

## 시작

- 일시: {ISO}
- base SHA: `{sha}`
- 시작 단계: 전체 / 밀스톤 X 부터
- 브랜치: feature/...

## 밀스톤 A — {제목}

### A1. CREATE `packages/...`

- 적용: ✅ Write (LOC 42)

### A2. EDIT `packages/...`

- 적용: ✅ Edit (3 줄 변경)

### A3. ...

### 검증

- pnpm typecheck: PASS
- pnpm --filter @finclaw/x test --run: 12 pass / 0 fail
- pnpm --filter @finclaw/x build: PASS

### 커밋

- SHA: `{short-sha}`
- subject: feat(phase{NN}): 밀스톤 A — ...

## 밀스톤 B — ...

(동일 구조)

## 종료

- 마지막 커밋: `{short-sha}`
- 미해결 이슈: 없음
- 발견된 todo.md 결함: 없음 / {목록}
- 발견된 phase 범위 밖 dead code: 없음 / {목록 — 삭제 X, 보고만}
```

## 8. 정지 시나리오

다음 상황에서 즉시 정지하고 SendMessage:

| 상황                      | 메시지                                                                    |
| ------------------------- | ------------------------------------------------------------------------- |
| typecheck FAIL            | "밀스톤 X 검증 실패: typecheck `<핵심 에러>` — 정지"                      |
| test FAIL                 | "밀스톤 X 검증 실패: N 개 테스트 실패 `<위치>` — 정지"                    |
| todo.md 코드 컴파일 안 됨 | "단계 X{N} 의 코드가 컴파일 안 됨 — todo.md 결함 가능. 정지"              |
| 커밋 lefthook 3 회 실패   | "밀스톤 X 커밋 실패 (lefthook 3 회) — 정지"                               |
| 파일 경로 오류            | "단계 X{N} 의 경로 `{path}` 가 존재하지 않거나 부모 디렉토리 부재 — 정지" |
| 워크스페이스 dirty        | "시작 시 uncommitted 변경 발견 — 정지"                                    |
| main 브랜치에서 시작      | "main 브랜치에서 시작 시도 — 정지. phase 전용 브랜치 필요"                |

정지 후 사용자 결정 대기. 자체 재시도 / 우회 X.

## 9. 안전 규칙 요약

1. todo.md 가 명시한 변경만. 자체 추가 X.
2. 무관한 dead code 발견 → 보고만, 삭제 X.
3. 검증 fail 시 즉시 정지, 자체 수정 X.
4. `git add -A` / `git add .` X — 명시적 파일만.
5. `--no-verify` X.
6. main 직접 커밋 X.
7. 외부 API 호출 X (mock 만).
8. 추측·재해석 X.
