# 브랜치 · 커밋 · PR 정책

FinClaw 는 1인 레포지만, 변경 이력이 곧 감사 기록이다. 사람이든 에이전트든 아래 규칙을 따른다.

## 브랜치

- `main` 은 항상 배포 가능한 상태다. **직접 커밋·force-push 금지** — 모든 변경은 PR 로 들어온다.
- 작업 브랜치는 최신 `main` 에서 딴다. 이름은 `<type>/<slug>` (소문자, 하이픈):

  | 접두사     | 용도             | 예                      |
  | ---------- | ---------------- | ----------------------- |
  | `feature/` | 기능·리팩토링    | `feature/agent-loop`    |
  | `fix/`     | 버그 수정        | `fix/scheduler-stagger` |
  | `chore/`   | 의존성·빌드·설정 | `chore/bump-vitest`     |
  | `docs/`    | 문서만           | `docs/git-policy`       |

- 한 브랜치 = 한 주제. 관련 없는 변경을 섞지 않는다.
- 머지된 브랜치는 로컬·원격 모두 지운다.

## 커밋

- [Conventional Commits](https://www.conventionalcommits.org/) — `type(scope): subject`. `lefthook` 의 `commit-msg` 훅이 강제한다.
  - `type`: `feat` `fix` `docs` `style` `refactor` `perf` `test` `build` `ci` `chore` `revert`
  - `scope`: 패키지·영역 이름 (`agent`, `gateway`, `storage`, `mac` …). 생략 가능.
  - `subject`: **ASCII**, 명령형, 72자 이내, 마침표 없음. (한글 subject 는 훅이 거부한다. 본문은 한글 가능.)
- 커밋 하나 = 논리적 변경 하나. 큰 작업은 **밀스톤 단위**로 끊고, 각 커밋은 단독으로 빌드·테스트를 통과해야 한다.
- 본문에는 "무엇"이 아니라 "왜"를 쓴다. 되돌리기 쉬워야 하는 변경(삭제 등)은 별도 커밋으로 분리한다.
- `pre-commit` 훅(lint · format · typecheck)을 `--no-verify` 로 건너뛰지 않는다.
- AI 가 작성에 참여한 커밋은 `Co-Authored-By:` 트레일러를 남긴다.

```
feat(agent): persist CLI session id per conversation

Resumed turns lost RAG context because one process-wide session was shared
by every channel. Key the session by sessionKey and store it in agent_sessions.

Co-Authored-By: Claude <noreply@anthropic.com>
```

## PR

- 제목은 커밋과 같은 Conventional Commits 형식.
- 본문에 **요약 · 사용자가 체감하는 변화 · 검증 방법과 결과 · 범위 밖으로 남긴 것**을 쓴다.
- 올리기 전 로컬 게이트: `pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test:ci` (storage 를 건드렸으면 `pnpm test:storage` 도).
- CI `Quality Gate` 가 초록이어야 머지한다.
- 머지 방식은 **merge commit** (`gh pr merge --merge`). squash·rebase 머지는 쓰지 않는다 — 밀스톤 커밋이 `main` 에 그대로 남아야 감사·bisect·부분 revert 가 가능하다.
- 리뷰 중인 브랜치는 force-push 하지 않는다. 수정은 커밋을 추가한다.

## 계획 문서

큰 작업은 `plans/<주제>.md` 하나에 결정·범위·검증 결과를 남긴다. 작성·검토 흐름은 `CLAUDE.md` 의 "개발 워크플로 (gstack)" 를 따른다.
