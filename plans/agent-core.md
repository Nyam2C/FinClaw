# 자체 에이전트 루프

> 작성 2026-11-26 · 상태: 구현됨 (`feature/agent-loop`) — 계획과 달라진 것 · 검토 결과 · 실측은 §9
> 사용자 결정: Claude Code(`claude` CLI)를 감싸지 않고 **자체 에이전트를 구현**한다. API 키를 쓴다. 최신 아키텍처를 적용한다.
> 근거 조사: [`research/agent-architectures.md`](research/agent-architectures.md) (이하 **[조사]**)

## 1. 문제

지금 FinClaw 는 턴마다 `claude -p` 프로세스를 띄우고 출력을 받아 적는다. 도구를 고르고, 결과를 다시 넣고, 언제 멈출지 정하는 루프가 우리 코드가 아니다. 그래서 [조사] §4 채점이 26점 중 10점이다: stop reason 분기 · 병렬 도구 · 트랜스크립트 · 캐시 확인 · eval 이 전부 0~1점이다.

## 2. 목표와 범위

**목표:** 루프를 FinClaw 가 소유한다. [조사] §2 의 수렴 구조 13개 중 v1 항목을 구현해 체크리스트 1~12 를 2점으로 올린다.

**범위 안**

- Anthropic Messages API 를 직접 부르는 루프 (`@anthropic-ai/sdk`, 스트리밍)
- append-only 트랜스크립트 (기존 `messages` 테이블 재사용)
- 프리픽스 고정과 프롬프트 캐싱, 토큰 예산, 종료 사유 타입
- `claude` CLI 드라이버와 CLI 전용 MCP 서버 삭제
- 가짜 모델로 도는 루프 테스트, 작은 eval 세트

**범위 밖 (이 계획에서 하지 않는다)**

- 도구 구성 변경 (`route_task` 정리, 토스 도구) — [`toss-openapi.md`](toss-openapi.md) 에서 한다
- 히스토리 요약(compaction), 노트형 메모리, 승인 중단, 실행 중 입력 끼워넣기 — §8
- 맥 앱 · 게이트웨이 RPC · Discord · cron 의 동작 변경 — 이벤트 형식을 유지해 손대지 않는다

## 3. 구조

```
맥 앱 · Discord · TUI/Web · cron
        │  (RPC / WebSocket — 변경 없음)
    AgentRuntime            세션 줄 세우기 · 컨텍스트 조립 · 트랜스크립트 저장 · 감사
        │  DriverRequest { system, tools, messages } → AgentEvent 스트림
    runLoop                 packages/agent/src/runtime/loop.ts — 새로 만든다
        ├─ stream()         Anthropic SDK 스트리밍 1회 호출 (테스트에서는 가짜)
        └─ runTool()        도구 레지스트리 직접 호출 (정책 · 가드 · 타임아웃은 레지스트리가 이미 한다)
```

루프는 저장소 · 채널 · 세션을 모른다 ([조사] 패턴 1). 입력으로 메시지 배열을 받고, 트랜스크립트에 덧붙일 것이 생길 때마다 이벤트로 내보낸다. 저장은 `AgentRuntime` 이 한다.

### 3.1 루프

```
runLoop(req):
  messages = req.messages                       # 이전 대화 + 이번 user 턴
  for turn in 1 .. maxTurns + 1:
    last = turn > maxTurns                      # 상한 도달 → 마무리 호출
    msg = await stream({ system, tools, messages,
                         tool_choice: last ? none : auto }, signal)   # 도구 정의는 그대로 둔다 (캐시 유지)
    usage += msg.usage
    yield message(assistant, msg.content)       # 블록 전체를 그대로. 저장이 도구 실행보다 먼저 일어난다
    messages.push(assistant)

    switch msg.stop_reason:
      refusal     → return error(refusal)
      pause_turn  → continue                    # 같은 히스토리로 재요청
      max_tokens  → tool_use 가 있으면 실행하지 않고 전부 is_error 결과로 돌려준 뒤 continue
                    없으면 지금까지의 텍스트로 done(truncated)
    calls = msg.content 의 tool_use 블록
    if calls 가 없으면 → return done            # 유일한 정상 종료
    if usage 가 예산 초과 → return error(budget)

    results = await Promise.all(calls.map(runTool))     # 전부 조회 도구라 병렬. 실패는 is_error 결과
    yield message(tool, results)                # 한 턴의 결과는 메시지 하나에, 호출 순서대로
    messages.push(user(results))
```

- **종료 사유는 타입으로 구분한다.** `done` 과 `error{reason}` 둘 다 usage · 턴 수를 싣는다. `reason` 에 `refusal` · `budget` · `max_turns` 를 추가한다 (기존: `auth` `rate_limit` `timeout` `aborted` `unknown` 등).
- **중단(abort)** 은 스트림과 도구에 같은 `AbortSignal` 을 넘긴다. 도구 실행 중 중단되면 남은 tool call 마다 `is_error` 결과를 합성해 짝을 닫고 끝낸다 ([조사] 패턴 6).
- **재시도** 는 SDK 기본값(2회, 429 · 5xx · 연결 오류)에 맡긴다. 스트림이 첫 글자 전에 끊기면 한 번 다시 보낸다. 그 밖의 분류는 SDK 타입드 에러 4종만: 인증(`auth`) · 한도(`rate_limit`) · 잘못된 요청(`unknown`) · 그 외.
- **타임아웃** 은 지금 값을 유지한다 (무출력 120초 · 전체 300초).

### 3.2 트랜스크립트

기존 `messages` 테이블(`conversation_id, role, content, created_at`)을 그대로 쓰되 **덧붙이기만** 한다. 스키마 변경은 없다.

| role        | content                                                         | API 로 보낼 때                           | 화면 이력에      |
| ----------- | --------------------------------------------------------------- | ---------------------------------------- | ---------------- |
| `system`    | 턴 컨텍스트 (시각 · 기억 · 거래 · 직전 대화 요약)               | 바로 뒤 `user` 메시지의 첫 text 블록으로 | 숨김             |
| `user`      | 사용자 원문                                                     | `user`                                   | 보임             |
| `assistant` | Anthropic content 블록 JSON (thinking · text · tool_use 그대로) | `assistant`                              | text 블록만 보임 |
| `tool`      | tool_result 블록 JSON                                           | `user`                                   | 숨김             |

- 지금의 "run 끝에 전체를 지우고 다시 쓰기"(`upsertConversation`)를 "step 마다 행 추가"(`appendMessages`)로 바꾼다. 정렬은 `rowid`.
- **재개할 때 짝을 정산한다:** 마지막 assistant 행에 결과 없는 tool_use 가 있으면 `is_error` 결과를 덧붙이고 시작한다.
- thinking 블록은 받은 그대로 되돌려 보낸다. 그 블록은 만든 모델에서만 유효하므로, **모델이 바뀌면 컨텍스트를 새로 시작한다** (아래 회전과 같은 처리).

### 3.3 컨텍스트 조립과 캐시

- 시스템 프롬프트는 정적이다 (지금도 그렇다). 도구 정의는 이름순으로 고정한다. 둘 다 세션 동안 바이트 단위로 같다.
- 턴마다 바뀌는 것(시각, 기억 `[mem:]`, 거래 `[txn:]`)은 지금처럼 user 턴 앞에 붙인다 — 이미 [조사] 패턴 7 과 같다.
- 캐시 breakpoint: 시스템 프롬프트 끝 1개 + 자동 캐싱(대화 꼬리). 응답의 `cache_read_input_tokens` 를 `agent_runs` 에 기록해 적중을 확인한다.
- **컨텍스트 회전:** API 로 보내는 범위는 "마지막 회전 지점 이후"다. 회전 조건은 (a) 6시간 무대화 (지금 규칙 유지), (b) 직전 응답의 입력 토큰이 15만을 넘음, (c) 모델 변경. 회전하면 직전 대화 6개를 요약 블록으로 턴 컨텍스트에 넣는다 (지금의 recap 재사용). 원문은 지우지 않는다.
  `ponytail:` 요약이 아니라 잘라내기다. 한 세션에서 긴 맥락이 필요해지면 서버 측 compaction 으로 바꾼다 (§8).

### 3.4 모델과 예산

- 기본 모델 `claude-opus-5-5`, 스트리밍, `max_tokens` 16000. thinking 은 모델 기본값(adaptive)에 맡긴다. 샘플링 파라미터는 보내지 않는다.
- 반복 상한 10 (지금과 같다). 넘으면 도구 호출을 막은 마무리 호출 1회.
- run 당 토큰 예산: 입력+출력 누적 40만 (cron · `agent.run` 은 20만). 가격표를 코드에 넣지 않으려고 달러가 아니라 토큰으로 건다.

## 4. 바뀌는 파일

| 구분   | 파일                                                                        | 내용                                                                                                             |
| ------ | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 새로   | `packages/agent/src/runtime/loop.ts`                                        | §3.1 루프 + SDK 스트림 어댑터                                                                                    |
| 새로   | `packages/agent/test/runtime/loop.test.ts`                                  | 가짜 스트림 함수로 §6 시나리오                                                                                   |
| 고침   | `packages/agent/src/runtime/types.ts`                                       | `DriverRequest` 의 `session` · `mcp` → `messages` · `tools`. `AgentEvent` 에 `message` 추가, `cliSessionId` 제거 |
| 고침   | `packages/server/src/agent-runtime/runtime.ts`                              | CLI 세션 바인딩 · `session_not_found` 재시도 제거, 회전 판정, step 마다 저장                                     |
| 고침   | `packages/storage/src/tables/conversations.ts`                              | `appendMessages`, 정렬 `rowid`                                                                                   |
| 고침   | `packages/gateway/src/rpc/methods/chat.ts`                                  | `chat.history` 가 `user` 원문과 `assistant` text 블록만 돌려줌                                                   |
| 고침   | `packages/server/src/router/sub-agent.ts`                                   | 같은 루프를 도구 없이 1회 호출                                                                                   |
| 고침   | `packages/server/src/main.ts`, `composition/*`                              | SDK 클라이언트 생성, `claude --version` 확인 · MCP 토큰 발급 제거. 키가 없으면 명확한 오류로 부팅 중단           |
| 지움   | `packages/agent/src/runtime/cli-driver.ts` (393줄) + 테스트 · 픽스처        | CLI 래퍼                                                                                                         |
| 지움   | `packages/gateway/src/mcp/{host,bridge}.ts` (181줄) + 테스트, `/mcp` 라우트 | CLI 만 쓰던 MCP 서버. 플러그인 MCP **클라이언트**(`plugins/mcp-transport.ts`)는 남는다                           |
| 의존성 | `@anthropic-ai/sdk` 추가 (`packages/agent`)                                 |                                                                                                                  |
| 문서   | `README.md`, `.env.example`, 시스템 프롬프트의 CLI 관련 문장                | "구독 CLI" 설명 → API 키 필수                                                                                    |

## 5. 결정

| #   | 결정                                     | 고른 것                                    | 버린 것과 이유                                                                                              |
| --- | ---------------------------------------- | ------------------------------------------ | ----------------------------------------------------------------------------------------------------------- |
| A1  | 루프를 직접 쓸지 SDK Tool Runner 를 쓸지 | **직접 쓴다** (사용자 결정: 자체 에이전트) | Tool Runner(beta)는 루프를 대신 돌려 주지만, step 마다 저장 · 짝 정산 · 마무리 호출을 우리가 제어할 수 없다 |
| A2  | `claude` CLI 경로를 남길지               | **지운다**                                 | 구독용 예비로 남기면 경로가 둘이 된다. 대신 `ANTHROPIC_API_KEY` 가 없으면 동작하지 않는다                   |
| A3  | 트랜스크립트 저장 위치                   | 기존 `messages` 테이블에 행 추가           | 새 테이블 · 이벤트 소싱은 1인 앱에 과하다 ([조사] §5)                                                       |
| A4  | 긴 대화 처리                             | 회전(잘라내기 + 직전 6개 요약 블록)        | 직접 구현한 요약 compaction 은 수백 줄. 1M 컨텍스트에서 금융 Q&A 가 한도에 닿는 일은 드물다                 |
| A5  | 예산 단위                                | 토큰                                       | 달러는 가격표를 코드에 넣어야 하고 낡는다                                                                   |
| A6  | 기본 모델                                | `claude-opus-5-5`                          | 에이전트 결정. 비용을 줄이려면 설정에서 `claude-sonnet-5-5` 로 바꾼다                                       |
| A7  | 서브에이전트                             | 이 계획에서는 같은 루프의 1회 호출로 유지  | 없애는 것은 도구 정리와 함께 [`toss-openapi.md`](toss-openapi.md) 에서                                      |

A1 · A2 는 사용자가 정했다. A3~A7 은 에이전트가 자율 실행 중에 골랐다.

## 6. 검증

**루프 단위 테스트 (가짜 스트림 함수, API 호출 없음)**

1. 텍스트만 → `done`, usage · 턴 수 포함
2. tool_use 2개 → 병렬 실행, 결과가 호출 순서대로 한 메시지에
3. 도구 실패 · 없는 도구 → `is_error` 결과로 계속
4. `max_tokens` 로 잘린 tool_use → 실행하지 않음
5. `refusal` → `error{refusal}`, 재시도 없음
6. `pause_turn` → 같은 히스토리로 재요청
7. 반복 상한 → `tool_choice: none` 마무리 호출 후 `done`
8. 토큰 예산 초과 → `error{budget}`
9. 도구 실행 중 abort → 짝이 닫힌 채 `error{aborted}`
10. assistant 메시지 이벤트가 도구 실행보다 먼저 나온다
11. 인증 · 한도 오류 매핑

**런타임 · 저장:** step 마다 행이 추가됨 · 재시작 후 같은 세션 재개 · 짝 정산 · 회전 3조건 · `chat.history` 가 컨텍스트와 도구 행을 숨김.

**라이브 (`pnpm test:live`, 실키):** 도구 1회 호출 왕복, 연속 2턴에서 `cache_read_input_tokens > 0`.

**eval (`pnpm eval`, 실키, 수동):** 대표 질문 10개를 고정된 도구 결과로 돌리고 코드로 채점한다 — 기대한 도구를 불렀는가, 답의 숫자가 도구 결과에 있는 숫자인가, 도구 없이 시세를 지어내지 않았는가.

**게이트:** `pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test && pnpm test:storage`, 실서버 스모크(맥 앱 `--smoke` 포함).

## 7. 위험

| 위험                                           | 대응                                                               |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| 히스토리를 고쳐 보내 thinking 블록이 무효가 됨 | 덧붙이기만 한다. 모델이 바뀌면 회전. 테스트 6 · 저장 테스트로 고정 |
| 비용이 조용히 늘어남 (구독 → 토큰 과금)        | 토큰 예산, `agent_runs` 에 usage 4종 기록, 부팅 로그 `agent.auth`  |
| 캐시가 안 맞아 매 턴 전체 입력을 냄            | 프리픽스 고정 + 라이브 테스트로 `cache_read` 확인                  |
| 기존 대화(텍스트만 저장된 행)와 새 형식이 섞임 | 문자열 content 는 그대로 유효한 메시지다. 변환하지 않는다          |
| CLI 가 해 주던 세션 요약이 사라짐              | 회전 + recap. 긴 맥락 필요가 보이면 §8                             |

## 8. 나중에

| 항목                  | 도입 신호                           | 방식                                         |
| --------------------- | ----------------------------------- | -------------------------------------------- |
| 히스토리 요약         | 회전으로 맥락이 끊긴다는 불만       | 서버 측 compaction (beta) 부터               |
| 노트형 코어 메모리    | 같은 선호를 반복 설명하게 됨        | 글자 수 상한 있는 코어 + 기존 FTS 검색       |
| 쓰기 도구 승인 중단   | 첫 쓰기 도구를 넣을 때              | 도구에 `mutating`, 종료 사유에 `interrupted` |
| 실행 중 입력 끼워넣기 | 답을 기다리다 추가 질문을 자주 보냄 | step 경계 큐                                 |
| 모델 기반 채점        | 코드 채점으로 못 잡는 품질 문제     | 사람 판정으로 보정 후                        |

## 9. 구현 결과 (2026-11-26)

### 9.1 검토

gstack `/gstack-autoplan` 은 시작했다가 중단했다 — CEO · DX · 엔지니어링 3단계 전체와 약 400KB 의 절차 문서를 요구해, 1인용 앱의 계획 하나에는 과했다. 대신 독립 리뷰어(이 계획과 코드를 처음 보는 에이전트)에게 적대적 검토를 맡겼다. 27건이 나왔고 아래처럼 처리했다.

| 지적                                                                                                  | 처리                                                                                                                       |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **치명** 저장된 트랜스크립트를 API 가 거절하면 6시간 동안 매 턴 실패한다 (복구 경로를 지웠다)         | 보내기 전에 모양을 검사(`checkMessages`)하고, 거절(400)되면 창을 이번 턴에서 새로 열어 1회 재시도한다                      |
| 재시작 · 배포로 시스템 프롬프트 · 도구 목록이 바뀌면 예전 thinking 블록이 무효가 된다                 | 프리픽스 해시를 창 상태에 저장하고, 바뀌면 회전한다. "모델 변경 시 회전"은 뺐다 (API 가 읽을 수 없는 블록을 스스로 버린다) |
| 같은 role 이 이어지는 경우(실패한 턴 뒤 재질문 등)와 user 로 시작하지 않는 창이 정의돼 있지 않다      | 조립을 전체 함수로: 인접한 같은 role 은 합치고, 질문으로 시작하지 않는 앞부분은 버린다                                     |
| 토큰 예산이 캐시 토큰을 어떻게 세는지 없고, 넘으면 답 없이 오류가 난다                                | 새로 처리한 토큰(입력+캐시 쓰기+출력)만 세고, 넘으면 반복 상한과 같이 마무리 호출로 끝낸다                                 |
| 플러그인 도구 이름(`mcp:id:name`)은 API 의 이름 규칙에 안 맞는다                                      | 경계에서 바꿔 보내고 실행할 때 되돌린다                                                                                    |
| 레지스트리 타임아웃은 신호만 보낸다 — 신호를 무시하는 도구는 lane 을 영원히 잡는다                    | 루프가 도구를 중단 신호와 경주시키고, 지면 `is_error` 결과를 합성한다                                                      |
| 회전 판정에 쓸 "직전 프롬프트 크기"가 정의돼 있지 않다                                                | 종료 이벤트에 마지막 호출의 `contextTokens`(입력+캐시)를 싣고 창 상태에 저장한다. 정렬은 `rowid` 만 쓴다                   |
| `chat.history` 가 중간 말 · 빈 행을 보여 실시간 화면과 달라진다                                       | 턴마다 마지막 assistant text 만 돌려준다                                                                                   |
| content 를 첫 글자(`[`)로 판별해, 사용자가 친 JSON 배열이 블록으로 읽힌다                             | role 로 판별한다 (assistant · tool 행만 블록)                                                                              |
| 거절된 턴이 컨텍스트에 남아 다음 턴도 거절될 수 있다                                                  | 거절 · 컨텍스트 초과로 끝난 창은 다음 턴에 회전한다                                                                        |
| 도구가 보는 사용자 id(`finclaw`)가 앱이 만든 알림의 소유자(`default`)와 달라 `list_alerts` 가 못 본다 | `default` 로 맞췄다 (CLI 시절부터 있던 버그)                                                                               |
| 꼬리 캐싱은 도구 없는 1회 호출에 할증만 된다                                                          | 도구가 있을 때만 건다                                                                                                      |
| `tokens_input` 이 캐시 적중 시 몇 토큰만 남아 감사에 쓸 수 없다                                       | `agent_runs.tokens_input` 에 프롬프트 전체(캐시 포함)를 쓴다. 4종 내역은 `agent.run.usage` 로그                            |
| 무활동 타이머는 스트리밍 호출에 맞지 않는다 · thinking 만 하다 끝나면 빈 답이 나간다                  | 무활동 타이머를 지우고 전체 타이머만 둔다. text 없는 응답은 저장하지 않고 오류로 끝낸다                                    |
| `!finclaw reset` 이 세션 lane 밖에서 지운다                                                           | `runtime.reset` 을 거치게 했다                                                                                             |
| 402(크레딧 부족)가 분류에 없다                                                                        | `auth` 로 묶고 안내 문구에 크레딧을 넣었다                                                                                 |
| `pause_turn` 분기 · `max_turns` 사유 · 손으로 짠 스트림 재시도는 죽은 코드다                          | 넣지 않았다                                                                                                                |

**고치지 않고 남긴 것**

- 트랜스크립트가 끝없이 자라고 매 턴 전부 읽는다. 도구 결과(계좌 정보 포함)가 로컬 SQLite 에 기한 없이 남는다. → 창 밖의 오래된 행 삭제와 범위 조회는 다음 작업으로 둔다.
- 서브에이전트(`route_task` 의 `market_analysis`)의 사용량이 감사에 안 잡힌다. → 서브에이전트 자체를 [`toss-openapi.md`](toss-openapi.md) 에서 지운다.
- 레지스트리의 반복 호출 감지기가 프로세스 전역 이력을 쓴다 (전부터 있던 것).
- `max_tokens` 로 잘린 tool_use 는 "한도를 올려 재시도"가 아니라 오류 결과로 돌려준다 (16K 에서 드물다).

### 9.1b 구현 diff 리뷰 (gstack `/gstack-review`)

브랜치 diff 에 전문 리뷰어 6명(테스트 · 유지보수성 · 보안 · 성능 · API 계약 · 단순화)과 적대적 리뷰어 1명을 돌렸다. 막는 결함은 없었고, 아래를 같은 브랜치에서 고쳤다.

| 지적                                                                                           | 처리                                                                                                   |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 400 이면 무조건 창을 새로 열어, 공백 입력 한 번에 대화 맥락이 사라진다                         | 공백 입력은 저장 · 전송 전에 거절. 재시도는 첫 호출에서 거절됐을 때만, 재시도도 거절되면 창을 되돌린다 |
| 도구를 돌린 뒤 400 이 나면 첫 시도의 행이 새 창에 섞인다                                       | 그 경우는 재시도하지 않는다                                                                            |
| 바꾼 도구 이름이 겹칠 수 있다 (`mcp:a:b_c` · `mcp:a_b:c`)                                      | 번호를 붙여 구분한다. 정렬은 로케일과 무관한 코드 단위 비교로 바꿨다                                   |
| Discord 발신자를 확인하지 않아, 봇에 닿는 누구나 소유자의 알림(이후 계좌)을 볼 수 있다         | `DISCORD_ALERT_USER_ID`(소유자 id)가 보낸 메시지만 받는다. 없으면 Discord 대화를 받지 않는다           |
| 매 턴 트랜스크립트 전체를 읽고 파싱한다 · `ORDER BY rowid` 가 임시 정렬을 탄다                 | 범위 조회(`offset` · `tail`)와 `(conversation_id)` 인덱스. 런타임은 창 이후만, 이력은 꼬리만 읽는다    |
| 오류 메시지에 프로바이더 원문(JSON · request_id)이 섞여 채널로 나간다                          | `message` 는 짧은 고정 요약, 원문은 로그 전용 `detail`                                                 |
| 레지스트리 타임아웃이 신호만 보낸다 (루프는 run 신호와만 경주)                                 | 레지스트리가 도구를 타임아웃 · 중단 신호와 경주시킨다                                                  |
| `agent.run` 의 입력 토큰과 `agent_runs` 의 값이 다르다 · `/status` 메시지 수가 부풀려진다      | 둘 다 프롬프트 전체(캐시 포함)로 통일. `/status` 는 user · assistant 행만 센다                         |
| 죽은 필드 · 내보내기 · 낡은 주석 · README 불일치                                               | `costUsd`, 안 쓰는 export, `now` 옵션, `RunContext.record`, CLI 시절 주석 · 문구 정리                  |
| 빠진 테스트 (키 없는 드라이버, 이름 충돌, 재시도 경계, refusal 문구, 맥 앱의 접두사 없는 이름) | 추가                                                                                                   |

**하지 않은 것:** gstack 이 요구하는 Red Team 추가 리뷰, 절차형 탐색 QA, 수정 후 재리뷰 사이클, Codex(외부 모델) 리뷰는 돌리지 않았다 — 외부 리뷰는 코드를 OpenAI 로 보내는 일이라 사용자 동의 없이 하지 않았다.

**알고 남긴 것**

- `chat.history` 가 진행 중인 턴의 행도 돌려줘, 맥 앱 패널을 실행 도중에 펼치면 중간 말이 잠깐 두 번 보일 수 있다 (코드로 추적, 실제 관찰은 아님).
- 답이 `max_tokens`(16K, thinking 포함)에 잘려도 완성된 답처럼 전달된다.
- 플러그인 MCP 도구의 `require-approval` 정책은 실행을 막지 않는다 (전부터). 루프는 모든 도구가 조회 전용이라고 가정하고 병렬로 돌린다 — 쓰기 도구를 넣기 전에 승인 중단을 만들어야 한다.
- 토큰이 있는 클라이언트는 `chat.start` 에 임의의 모델을 줄 수 있고, 일 단위 지출 상한이 없다.
- 맥 앱 테스트 픽스처(`frames.jsonl`)는 예전 서버 프레임이다 (접두사 붙은 도구 이름, `costUsd`). 디코더는 둘 다 받는다.

### 9.2 계획과 달라진 것

- 키가 없을 때 부팅을 멈추지 않는다. 알림 · 조회 RPC 는 모델 없이 동작하고 CI · 스모크도 키 없이 부팅해야 해서, 경고 로그를 남기고 run 을 `error{auth}` 로 끝낸다.
- 턴 컨텍스트는 mid-conversation `role: "system"` 메시지가 아니라 user 메시지의 앞 text 블록으로 보낸다 — 모델 지원 여부와 무관하고, 저장된 행에서 결정적으로 조립된다.
- §3.3 의 회전 조건 (c) 는 "모델 변경"이 아니라 "프리픽스 해시 변경"이다. §3.4 의 예산은 캐시 읽기를 빼고 세며, 넘으면 오류가 아니라 마무리 호출이다. §3.1 의 무활동 타이머는 없다.
- 종료 사유: `refusal` · `invalid_request` · `context_overflow` 를 추가하고 `budget` · `max_turns` · CLI 전용 사유(`session_not_found` · `mcp_unavailable` · `spawn`)를 지웠다.

### 9.3 실측 (이 기기, 실키)

| 확인                             | 결과                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------- |
| 루프 단위 테스트 (검증하는 가짜) | 32개 통과 — 가짜 스트림이 API 가 거절할 요청을 똑같이 거절한다                         |
| 전체 게이트                      | build · typecheck · lint · format 통과, 단위 1050 · 스토리지 141 · Swift 89 통과       |
| 라이브 (`runtime.live.test.ts`)  | 도구 1회 호출 왕복, 2턴째 `cacheRead > 0`                                              |
| 실서버 + 맥 앱 `--smoke` 2턴     | 도구 시작/끝 · delta · 종료 이벤트 수신, 후속 질문이 앞 턴을 이어받음                  |
| 저장된 트랜스크립트              | `system · user · assistant(tool_use) · tool · assistant(thinking+text)` 순서로 행 추가 |
| 캐시                             | 1턴 두 번째 호출 `cacheRead` 2,778 · 2턴 `cacheRead` 2,895 (새 입력 4 토큰)            |

**아직 없는 것:** eval 세트 (§6) — 토스 도구가 붙은 뒤 실제 도구 이름으로 만든다. 체크리스트 12번은 그때까지 0점이다. 실기기 확인이 필요한 것: 중단(abort) 직후 다음 턴, 재시작 후 thinking 블록이 있는 대화 재개.
