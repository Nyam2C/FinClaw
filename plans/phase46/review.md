# Phase 46 Review: 에이전트 코어 재설계 (AgentRuntime + stream-json 드라이버)

> todo.md 기반 구현 코드 리뷰. 구현 완료 상태, 검증 결과, 리팩토링 사항을 기록한다.
> 상태: **확정 — /goal 자율 모드에서 메인이 게이트 3 을 대행 승인 (2026-11-26). 사용자 사후 검토 대상.**
> 검토: phase-qa-engineer + phase-refactor-expert 병렬(각자 독립 보고) → 메인 통합. P0 0건, P1 8건은 같은 브랜치에서 수정 커밋으로 반영.

base SHA: `01fbec2` ↔ HEAD: 본 커밋 (packages 변경: 108 파일, +4,645 / −3,580 · 프로덕션 코드 26,438 → 26,349 LOC)

---

## 0. 한 문단 결론

네 벌이던 실행 경로(Discord 파이프라인 · gateway chat · scheduler · agent.run)가 `AgentRuntime.run() → AgentEvent` 하나로 수렴했다. 런타임은 `claude -p --output-format stream-json` 을 **강제 격리 플래그**와 함께 턴마다 spawn 하고, 대화별 CLI 세션(6시간 유휴 시 회전 + recap), 턴별 `<context>` 주입, 실제 스트리밍, 도구 호출 감사, 취소/초기화를 소유한다. phase45 review §5 의 버그 B1·B3·B4·B5·B6·B10·B11·B12 와 이번에 드러난 격리 결함 N1·N2 가 닫혔다. **merge 가능.**

## 1. 구현 사항 (TODO 일치도)

구현 단계 89개 대조: ✅ 68 · ⚠️ 21 · ❌ 0. ⚠️ 21건은 전부 구현 로그에 사유가 기록된 의도된 차이다(실측 픽스처에 맞춘 단언 조정, 타입 오류 최소 수정, 테스트 describe 위치 등). plan 확정 수치 19개(6h 회전, recap 6×500, 컨텍스트 6,000자, 타임아웃 120/300·45/75·90, MCP 유휴 10분, `--max-turns 10`, `--autocompact 200000`, transcript 40, 전역 동시 2 …)는 코드 상수와 전부 일치. 마이그레이션 0 (SCHEMA_VERSION 12 유지).

| 밀스톤 | 내용                                                                                                                             | 커밋      |
| ------ | -------------------------------------------------------------------------------------------------------------------------------- | --------- |
| M1     | stream-json 드라이버 seam(`agent/src/runtime/`) — 격리 argv 강제, readline NDJSON, 워치독, SIGINT→2s→SIGKILL, 실측 픽스처 테스트 | `4530c5e` |
| M2     | `AgentRuntime`(`server/src/agent-runtime/`) — 세션 바인딩·회전·recap, prepareTurn, lane, agent_runs/conversations 기록           | `f180183` |
| M3     | Discord 파이프라인·서브에이전트를 runtime 으로 (N1: 서브에이전트 격리, abort 전파)                                               | `28cf6e5` |
| M4     | chat·scheduler·agent.run 을 runtime 으로 (`chat.send` 즉시 `{runId}` 반환, Web/TUI 는 end 에서 최종 텍스트로 교체)               | `a53ddeb` |
| M5     | Runner·ProviderAdapter·옛 CLI 체인 삭제 (삭제 전용 커밋, 프로덕션 15 파일 + 테스트 11 파일)                                      | `9355ea7` |
| M6     | `chat.stream.tool` + `chat.abort` / `chat.reset`                                                                                 | `0812094` |
| M7     | 명령 응답 전달(B4) + Discord 실행 에러 고정 문구                                                                                 | `3935001` |
| M8     | 결정적 cron stagger(B5)                                                                                                          | `a728e70` |
| M9     | MCP 유휴 세션 만료(B12)                                                                                                          | `f09c8f8` |
| M10    | gateway `127.0.0.1` 기본 + `~/.finclaw/gateway.{secret,token}` + CLI/TUI 인증(B6·B10)                                            | `aff2c02` |
| M11    | Discord 토큰 없이 부팅                                                                                                           | `bf334dd` |
| M12    | README·env·에이전트 문서 동기화                                                                                                  | `34d8d33` |

plan 과 다르게 간 곳(todo 단계에서 결정): CLI 는 config 토큰을 읽지 않고 토큰 파일만 쓴다(TUI 는 config 우선). "토큰 없이 main 부팅" 테스트는 `setupDiscord` 단위 테스트 + 최종 실 스모크로 대체.

## 2. 자동화 검증 결과

| 명령                                | 결과                    | 비고                                                     |
| ----------------------------------- | ----------------------- | -------------------------------------------------------- |
| `pnpm build` (dist 삭제 후)         | ✅ PASS                 |                                                          |
| `pnpm typecheck`                    | ✅ PASS                 |                                                          |
| `pnpm lint`                         | ✅ 0 warnings, 0 errors |                                                          |
| `pnpm format`                       | ✅ PASS                 |                                                          |
| `pnpm test`                         | ✅ 1007 pass / 0 fail   | 133 files (기준선 960 → +47)                             |
| `pnpm test:storage`                 | ✅ 141 pass / 0 fail    | 22 files                                                 |
| `pnpm test:ci` · web vite build     | ✅ PASS                 |                                                          |
| mock-only 격리                      | ✅ PASS                 | API 키 unset, 테스트는 실제 `~/.finclaw` 미접근          |
| `pnpm test:live` (드라이버, 실 CLI) | ✅ 5/5                  | 구현 단계에서 1회 실행 (claude 2.1.332, haiku) — 아래 표 |

**go/no-go (실 CLI 실측)**

| #   | 전제                                                                 | 결과                                                            |
| --- | -------------------------------------------------------------------- | --------------------------------------------------------------- |
| G1  | 격리 플래그가 사용자 CLAUDE.md·훅·플러그인·스킬을 차단               | go — tools `[]`, skills `[]`, 플러그인은 builtin 4개만          |
| G2  | 도구를 쓴 턴의 최종 텍스트가 비어 있지 않음                          | go — 3턴 모두 `end.result.text` = delta 누적                    |
| G3  | SIGINT 후 2초 안 종료, 고아 프로세스 0                               | go — 517ms, 고아 0, 마지막 이벤트 `error{aborted}`              |
| G4  | resume 실패를 `session_not_found` 로 분류                            | go                                                              |
| G5  | `--max-turns` · `--autocompact 200000` · `--permission-prompts none` | go — 세 플래그 모두 수용                                        |
| G6  | resume 턴 첫 delta 지연                                              | 측정만 — p50 3.2초 (1.2 / 3.2 / 3.2초). 상주 프로세스 판단 근거 |
| G7  | MCP 연결·도구 호출 감사                                              | go — `tool_calls_json` 에 호출 기록, `mcp_unavailable` 0        |

**실 서버 스모크 (3회: M4 후 · M6 후 · M11 후)** — 최종 회차는 Discord stub 없이, `DISCORD_BOT_TOKEN`·`GATEWAY_JWT_SECRET`·`ANTHROPIC_API_KEY` 전부 미설정:

1. Discord 없이 부팅, `lsof` 상 `127.0.0.1:3000` 에만 listen
2. secret·token 파일 `-rw-------`, 서버 로그에 secret/token 문자열 0건
3. 토큰 없음 → `chat.start` -32001 · 위조 토큰 → WS 4001 · 토큰 파일의 토큰 → 성공
4. `chat.send` 1~2ms 반환 → 스트리밍 → 2턴째 기억 → 도구 턴(`chat.stream.tool` start/end 짝) → `chat.abort`(error 정확히 1회, end 없음) → `chat.reset`(새 CLI 세션, 이전 대화 기억 못 함)
5. `finclaw agent list` 가 토큰 파일로 인증돼 exit 0 (토큰 파일 없으면 exit 3)
6. 재시작 후 같은 secret 재사용 — 첫 부팅 토큰 계속 유효
7. SIGTERM 종료, 포트 해제, 고아 `claude -p` 0

실 CLI 로 검증하지 **않은** 경로: cron 실행, `agent.run` RPC, Discord 메시지 경로(단위 테스트만).

## 3. 경계면 검증

- **notification ↔ Web/TUI:** `chat.stream.{delta,tool,end,error}` 필드명 일치, end 에서 `result.text` 로 버퍼 교체. ⚠️ Web/TUI 는 runId 로 거르지 않는다 — 서버가 세션별로 run 을 직렬화해 현재는 무해, phase47 클라이언트는 runId 단위로 설계할 것.
- **RPC ↔ 호출부:** `chat.start/send/abort/reset`, `agent.run` 스키마와 web/tui/cli 호출부 일치. `RpcMethod` 유니온에 3개 메서드 누락(기존, P2).
- **runtime ↔ storage:** `agent_runs`(`tool_calls_json`·`used_memory_ids`·`cli_session_id`·`error`)와 `conversations.metadata.{cliSessionId,lastTurnAt}` 가 스키마와 일치.
- **파이프라인 ↔ 프롬프트:** 시스템 프롬프트가 `<context>`·`<recent_conversation>` 블록을 정확히 가리킨다(후자는 리뷰 수정으로 추가). 존재하지 않는 도구를 약속하지 않는다.
- **드라이버 argv ↔ plan §3-6:** 격리 플래그 전부 존재, 프롬프트는 `-p` 바로 뒤.
- **local-auth ↔ CLI/TUI/README:** 파일 경로·env 이름 일치.
- **개인정보(레포 PUBLIC):** 픽스처에 계정명·홈 경로·이메일·토큰 없음. 실제 `request_id`·thinking signature 는 남아 있음(P2).

## 4. 리팩토링 사항

### P0 — 즉시 (병합 전)

없음.

### P1 — 반영 완료 (리뷰 수정 커밋)

| 항목                                                                                                                                                                                   | 커밋      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- |
| per-run MCP JWT 만료를 10분으로 명시(리뷰는 "만료 없음"으로 봤으나 실제론 기본 15분이 있었다 — 전제 정정) · `chat.send` message 상한 20,000자 · compose 포트를 `127.0.0.1:` 로 publish | `008e477` |
| `activeRuns` 를 runId 키로(연속 send 시 abort 가 엉뚱한 run 을 멈추던 문제) · ChatRegistry TTL 을 시작 시각 절대 30분 → 마지막 활동 기준 유휴 30분, 진행 중 run 은 만료 안 함          | `9ac4da5` |
| `AgentErrorReason` 을 `@finclaw/types` 로 이동, `TerminalEvent` 타입 4중복 통합                                                                                                        | `e9df1d6` |
| `finclaw agent list`(응답 `{agents}` 를 배열로 읽던 문제) · `alert add`(파라미터 이름·enum 불일치로 항상 Invalid params) — B10 해소로 도달 가능해진 기존 결함                          | `37882ac` |
| 포맷 훅: 스테이징 파일이 전부 포맷 제외 대상이면 `oxfmt --check` 가 exit 2 로 커밋을 막던 문제                                                                                         | `0cdcf32` |
| 시스템 프롬프트: CLI 가 붙이는 `# userEmail`·`# Environment` 값을 답변에 쓰지 않는다 + `<recent_conversation>` 설명                                                                    | `f23758d` |
| slow consumer 시 delta 만 버리고 end/error/tool 은 항상 전송 · `abortAll()` 이 진행 중 run 의 감사 기록을 최대 3초 기다림 · `child.on('error')` · 빈 model 폴백                        | `53bb586` |
| stagger 데드존(정각 직후 계산 시 그 시간대 발화 소실) · 서브에이전트 전용 lane 으로 직렬화 복원(대기 10초 초과 시 명확한 에러)                                                         | `ba01ae8` |
| 토큰 파일을 포트 검사 **뒤**에 기록(두 번째 인스턴스가 토큰만 바꾸고 죽는 문제) · 기존 파일은 0600 으로 좁힌 뒤 쓰기                                                                   | `d14b649` |

보류: "종료 이벤트 drain 루프 4중복을 헬퍼로" — 적용해 보니 순증(+11줄)이고 호출부 의미가 달라(`sub-agent` 는 첫 종료에서 반환, scheduler 는 필드를 나눠 기록) 되돌렸다.

### P2 — 후속 (미반영)

1. **lane 대기가 abort 를 듣지 않는다** (`runtime.ts`, `infra/concurrency-lane.ts`) — 대기 중 abort 된 run 은 슬롯을 받을 때까지 큐를 점유하고, `chat.reset` 도 같은 대기 때문에 RPC 30초 타임아웃을 넘길 수 있다. `acquire` 에 signal 추가.
2. **종료 시간 예산 충돌** — `signal-handler` 는 30초 뒤 강제 종료, `scheduler.stop` 은 최대 60초 대기. cron 실행 중 SIGTERM 이면 `abortAll` 전에 죽을 수 있다.
3. **Discord 무응답 창** — 파이프라인 타임아웃 330초가 lane 대기 + run 시간 합에 걸려, 대기가 길면 abort 로 처리돼 조용히 버려진다. 파이프라인 abort 를 `timeout` 으로 매핑.
4. **자식 env 전체 상속** (`cli-driver.ts`) — `ANTHROPIC_API_KEY` 만 지우고 나머지(Discord·KIS·임베딩 키)는 CLI 프로세스로 간다. 도구가 없어 모델이 읽을 경로는 없지만 allowlist 가 안전.
5. **result 후 exit 대기** (`cli-driver.ts`) — CLI 가 result 를 내고 멈추면 `done` 이 idle 워치독(120초)까지 밀린다. 종료 확정 후 5초 유예.
6. **MCP URL 고정** (`main.ts`) — `http://127.0.0.1:<port>/mcp`. `GATEWAY_HOST` 를 특정 비-루프백 IP 로 주면 모든 run 이 `mcp_unavailable`.
7. **CLI 시작 지연** — `gateway-client` 가 토큰을 읽으려 `@finclaw/gateway` 배럴 전체를 로드(+~80ms/명령).
8. **정리 후보** — `composition/providers.ts`(21줄 래퍼, 로그 문구가 사실과 다름), `agent/src/providers/claude-cli/errors.ts`(디렉터리의 유일한 파일 → `runtime/` 로), 미사용 export(`mapStreamEvent`·`StreamState`), gateway 안 `activeRuns` 이름 충돌.
9. **Docker** — `~/.finclaw` 가 볼륨 밖이라 컨테이너 재생성마다 secret 이 바뀐다. 이미지에 `claude` CLI 없음(기존).
10. **CLI** — `market quote --currency`·`alert add --channel` 은 서버가 무시(기존).
11. **픽스처** — 실제 `request_id`·thinking signature 를 placeholder 로.
12. **테스트 공백** — prepareTurn 예외, lane 대기 중 abort, 에러 후 lane 해제, MCP sweep 통합.

## 5. 범위 밖 발견 (참고)

- **계정 컨텍스트 주입:** 격리 플래그를 다 써도 claude CLI 가 `# userEmail`(구독 계정 이메일)과 `# Environment`(cwd·git 여부·날짜) 블록을 대화에 붙인다(메인 실측). 끄는 플래그·env 는 문서에 없다(`--bare` 는 OAuth 를 못 읽어 사용 불가, `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS` 는 git 스냅샷만). 프롬프트 규칙으로 완화했고(§4), 근본 차단은 전용 `CLAUDE_CONFIG_DIR` + `claude setup-token` 조합이 후보(미검증).
- **시스템 프롬프트 반영 지연:** `--system-prompt-snapshot` 기본 on 이라 프롬프트 파일을 고쳐도 resume 중인 세션에는 다음 회전(6h 유휴) 또는 `chat.reset`/`!finclaw reset` 뒤에야 적용된다.
- **config strict:** `cliBackend.timeoutMs`·`watchdog` 키가 제거됐다. 예전 `config.example.json5` 를 복사해 쓴 config 는 부팅이 거부된다(오류 메시지가 경로를 짚는다).
- **LOC:** 프로덕션 순감은 −89 로 plan 추정(−480)에 못 미친다. 차이의 대부분은 `runtime.ts`·`cli-driver.ts` 두 파일(방어적 파서, 기록 책임 이동, 포매터의 세로 전개)이며, 리뷰 수정으로 +50 가량 늘었다. 원 추정이 낙관적이었다.

## 6. 사용자 사후 검토 대상 (자율 모드에서 메인이 정한 것)

plan §9 의 S1~S15 가 그대로 유효하다. 특히:

- **S1** 드라이버는 Agent SDK 가 아니라 `claude -p` (SDK 문서가 API 키 인증을 전제, 전송 계층 동일).
- **S2** `agent.run` RPC 와 "LLM 출력 → memory" 훅은 현 동작 유지 — 명시적 선언 기반 기억 원칙과의 긴장은 남아 있다.
- **S3** 세션 6시간 유휴 회전 + recap (상수 1개로 조정).
- **S7** gateway 기본 `127.0.0.1`, Web 은 `?token=$(cat ~/.finclaw/gateway.token)` 로 접속, TUI sessionKey 가 `tui:local:<agentId>` 로 바뀜.
- **S8·S9** `chat.send` 즉시 반환, WS 가 끊겨도 run 은 끝까지 돌아 저장.
- 리뷰에서 추가: `chat.send` message 20,000자 상한, 서브에이전트 동시 1개.
- 스모크가 실제 `~/.finclaw/` 에 `gateway.secret`·`gateway.token` 을 생성했다(제품의 정상 동작, DB 는 임시 경로 사용).

## 7. 다음 phase (47) 입력

맥 캐릭터 클라이언트가 의존할 **실측 인터페이스**:

- WS `ws://127.0.0.1:3000/`, 인증 `Authorization: Bearer <token>` 또는 `?token=`. 토큰 = `~/.finclaw/gateway.token` (HS256, 30일, 부팅마다 재기록, secret 이 같으면 이전 토큰도 유효).
- `chat.start {agentId?, model?}` → `{sessionId}` · `chat.send {sessionId, message}` → 즉시 `{runId}` · `chat.abort {sessionId, runId?}` → `{aborted}` · `chat.reset {sessionId}` → `{reset}`.
- notification: `chat.stream.delta {sessionId, runId, delta}` · `chat.stream.tool {sessionId, runId, toolCallId, name, phase, isError?}` · `chat.stream.end {sessionId, runId, result:{text, usage, costUsd?}}` · `chat.stream.error {sessionId, runId, error, reason: AgentErrorReason}`. 모든 run 은 end 또는 error 정확히 1개로 끝난다.
- sessionKey 는 `tui:<userId>:<agentId>` — 같은 사용자·에이전트면 재접속해도 같은 CLI 대화로 이어진다. ChatRegistry 세션(sessionId)은 유휴 30분 뒤 만료 → 클라이언트가 `chat.start` 재호출. 연결당 실행 세션 1개.

이월: alerts websocket 전달 + `alert.triggered`, `chat.history`, 클라이언트 지정 runId, `end.result` 에 `captured`/`usedMemoryIds`, 재연결 rebind, 상주 프로세스 여부(G6 p50 3.2초), `search_memory` 도구, messageId 세그먼트.
