# Phase 0 구현 리뷰

**리뷰 일시:** 2026-02-24
**대상:** `feature/init` 브랜치, todo.md 11개 작업 구현 결과

---

## 1. 변경 파일 요약

### 1.1 todo 작업 대상 (11개 작업)

| 구분    | 파일                           | 변경 유형 |
| ------- | ------------------------------ | --------- |
| 작업 1  | `.node-version`                | 신규 생성 |
| 작업 2  | `pnpm-workspace.yaml`          | 수정      |
| 작업 3  | `.gitignore`                   | 수정      |
| 작업 4  | `package.json`                 | 수정      |
| 작업 5  | `lefthook.yml`                 | 신규 생성 |
| 작업 6  | `.github/workflows/ci.yml`     | 신규 생성 |
| 작업 7  | `Dockerfile`                   | 신규 생성 |
| 작업 8  | `docker-compose.yml`           | 신규 생성 |
| 작업 9  | `.dockerignore`                | 신규 생성 |
| 작업 10 | `.github/workflows/deploy.yml` | 신규 생성 |
| 작업 11 | `scripts/build-docker.sh`      | 신규 생성 |

### 1.2 부수 변경 (oxfmt 포매팅)

| 파일                            | 변경 내용                                                  |
| ------------------------------- | ---------------------------------------------------------- |
| `packages/types/src/finance.ts` | union type을 단일 행으로 재포매팅                          |
| `packages/types/src/plugin.ts`  | import 정렬 (알파벳순)                                     |
| `packages/types/src/storage.ts` | import 정렬 (알파벳순)                                     |
| `plans/README.md`               | 마크다운 테이블 정렬                                       |
| `plans/phase00/todo.md`         | 마크다운 테이블 정렬, YAML 따옴표 통일, JSON 트레일링 쉼표 |
| `plans/phase20/plan.md`         | 마크다운 테이블 정렬                                       |
| `pnpm-lock.yaml`                | lefthook 의존성 추가 반영                                  |

---

## 2. 작업별 검증 결과

### Part A: 기존 파일 수정

**작업 1. `.node-version`** — PASS

- 내용: `22.21.1` (줄바꿈 포함, 단일 줄)
- plan 일치 여부: 완전 일치

**작업 2. `pnpm-workspace.yaml` — `minimumReleaseAge`** — PASS

- 추가: `minimumReleaseAge: 10080` + 한국어 주석 2줄
- plan 일치 여부: 완전 일치
- `pnpm install` 정상 동작 확인

**작업 3. `.gitignore` 수정** — PASS

- 추가: `coverage/`, `*.lcov`, `.lefthook-local/` (섹션 주석 포함)
- `grep -c` 결과: 3 (기대값 일치)
- plan 일치 여부: 완전 일치

**작업 4. `package.json` 수정** — PASS

- `scripts.prepare`: `"lefthook install"` 추가됨
- `devDependencies.lefthook`: `"^2.1.0"` 추가됨
- plan 일치 여부: 완전 일치

### Part B: 신규 파일 생성

**작업 5. `lefthook.yml`** — PASS (plan 대비 1건 변경)

- pre-commit: lint, format-check, typecheck 병렬 — plan과 일치
- commit-msg: Conventional Commits regex — plan과 일치
- **plan과의 차이점:**
  - plan: `MSG=$(head -1 "$1")`
  - 구현: `MSG=$(head -1 .git/COMMIT_EDITMSG)`
  - **평가: 올바른 변경.** lefthook의 commit-msg 훅은 `$1`로 파일 경로를 전달하지 않음. `.git/COMMIT_EDITMSG`를 직접 참조하는 것이 lefthook에서 정상 동작하는 방식.

**작업 6. `.github/workflows/ci.yml`** — PASS

- plan과 완전 일치 (46줄)
- checkout → pnpm-setup → node-setup → install → lint → format → typecheck → build → test:ci

**작업 7. `Dockerfile`** — PASS

- plan과 완전 일치 (62줄)
- 멀티 스테이지: builder (node:22-bookworm-slim) → runner
- 7개 패키지 package.json 개별 COPY, non-root USER, TODO 주석 3개

**작업 8. `docker-compose.yml`** — PASS

- plan과 완전 일치 (29줄)
- finclaw 서비스, finclaw-data 볼륨, TODO 주석 3개

**작업 9. `.dockerignore`** — PASS

- plan과 완전 일치 (20줄)
- node_modules, dist, .git, .env, test 파일 등 제외

**작업 10. `.github/workflows/deploy.yml`** — PASS

- plan과 완전 일치 (57줄)
- QEMU + Buildx + ghcr.io login + metadata + build-push (amd64/arm64)

**작업 11. `scripts/build-docker.sh`** — PASS

- plan과 완전 일치 (9줄)
- 실행 권한 설정 확인: `chmod +x` 적용됨

---

## 3. 최종 체크리스트 결과

| #   | 항목                                    | 결과   | 비고                                        |
| --- | --------------------------------------- | ------ | ------------------------------------------- |
| 1   | `.node-version` 존재                    | PASS   | `22.21.1`                                   |
| 2   | `pnpm-workspace.yaml` minimumReleaseAge | PASS   | `10080`                                     |
| 3   | `.gitignore` coverage/lcov/lefthook     | PASS   | 3건                                         |
| 4   | `package.json` prepare 스크립트         | PASS   | `lefthook install`                          |
| 5   | `package.json` lefthook devDep          | PASS   | `^2.1.0`                                    |
| 6   | `lefthook.yml` 존재                     | PASS   |                                             |
| 7   | `.github/workflows/ci.yml` 존재         | PASS   |                                             |
| 8   | `Dockerfile` 존재                       | PASS   |                                             |
| 9   | `docker-compose.yml` 존재               | PASS   |                                             |
| 10  | `.dockerignore` 존재                    | PASS   |                                             |
| 11  | `.github/workflows/deploy.yml` 존재     | PASS   |                                             |
| 12  | `scripts/build-docker.sh` 실행 가능     | PASS   |                                             |
| 13  | `pnpm install` 성공                     | PASS   | lefthook build script 경고 있음 (아래 참고) |
| 14  | `pnpm build` 성공                       | PASS   |                                             |
| 15  | `pnpm typecheck` 성공                   | PASS   |                                             |
| 16  | `pnpm lint` 성공                        | PASS   | 0 warnings, 0 errors (27 files, 122 rules)  |
| 17  | `pnpm format` 성공                      | PASS   | 76 files, all correct                       |
| 18  | `pnpm test` 성공                        | PASS   | 1 test passed                               |
| 19  | `pnpm test:ci` 성공                     | PASS   | unit PASS, storage PASS                     |
| 20  | lefthook pre-commit 동작                | 미검증 | 스테이징 필요 (수동 검증 대상)              |
| 21  | lefthook commit-msg 동작                | 미검증 | 수동 검증 대상                              |
| 22  | Docker 빌드                             | 미검증 | Docker 미설치 환경                          |

---

## 4. 부수 변경 분석

`pnpm format:fix` 실행에 의한 자동 포매팅 변경 3건:

1. **`packages/types/src/finance.ts`**: `InstrumentType` union을 여러 줄에서 단일 줄로 축약. oxfmt의 줄 길이 정책에 따른 자동 변환. 의미 변경 없음.
2. **`packages/types/src/plugin.ts`**: import 순서 `ChannelPlugin` ↔ `ToolDefinition` 교환. `experimentalSortImports` 규칙 적용. 의미 변경 없음.
3. **`packages/types/src/storage.ts`**: import 순서 `SessionKey,Timestamp,AgentId` ↔ `ConversationMessage` 교환. 동일 규칙 적용. 의미 변경 없음.

plans/ 하위 3개 파일은 마크다운 테이블 정렬 변경만 포함. 콘텐츠 변경 없음.

---

## 5. 발견 사항

### 5.1 lefthook build script 경고 (낮음)

```
Ignored build scripts: lefthook.
Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

`pnpm.onlyBuiltDependencies`에 `"lefthook"`이 없어 발생. lefthook은 `prepare` 스크립트(`lefthook install`)로 정상 동작하므로 기능에는 영향 없음. 경고를 없애려면 `onlyBuiltDependencies`에 추가 필요.

### 5.2 Vitest 4 deprecated 경고 (낮음)

```
DEPRECATED: `test.poolOptions` was removed in Vitest 4.
```

이번 변경과 무관한 기존 이슈. `vitest.config.ts`의 `poolOptions`를 top-level 옵션으로 마이그레이션해야 함.

---

## 6. 결론

**11개 작업 전체 PASS.** plan과의 의미 있는 차이는 `lefthook.yml`의 `$1` → `.git/COMMIT_EDITMSG` 1건이며, 이는 올바른 적응(lefthook 호환성).

부수 변경은 모두 oxfmt 자동 포매팅에 의한 것으로 의미 변경 없음.

---

## 7. 리팩토링 대상

| #   | 항목                                             | 우선순위 | 설명                                                                             |
| --- | ------------------------------------------------ | -------- | -------------------------------------------------------------------------------- |
| R-1 | `pnpm.onlyBuiltDependencies`에 `"lefthook"` 추가 | 낮음     | `pnpm install` 시 "Ignored build scripts" 경고 제거                              |
| R-2 | `vitest.config.ts` poolOptions 마이그레이션      | 낮음     | Vitest 4의 `test.poolOptions` deprecated 경고 해소. top-level 옵션으로 전환 필요 |
| R-3 | todo.md의 `lefthook.yml` 스펙을 구현에 맞게 갱신 | 낮음     | `$1` → `.git/COMMIT_EDITMSG` 반영 (문서-구현 일관성)                             |
