# 인기 오픈소스 에이전트의 구조 분석 (2026-11)

> 조사일 2026-11-26. 대상 레포를 shallow clone 해 **소스를 읽고** 정리했다 (코드는 실행하지 않았다). star 수와 커밋은 조사일의 `gh api` 값이다.
> 상세 근거(파일 경로 · 줄 번호)는 레인별 보고서에 있다:
> [`personal-assistants.md`](agent-architectures/personal-assistants.md) · [`harness-loops.md`](agent-architectures/harness-loops.md) · [`sdks-and-guidance.md`](agent-architectures/sdks-and-guidance.md)

## 1. 무엇을 봤나

| 분류               | 레포                                      | stars   | 언어       | 한 줄                                                                                  |
| ------------------ | ----------------------------------------- | ------- | ---------- | -------------------------------------------------------------------------------------- |
| 개인 비서          | `openclaw/openclaw`                       | 395,240 | TypeScript | 코어 루프 930줄(pi 계보) 위에 54만 줄짜리 런타임 · 게이트웨이. 세션은 per-agent SQLite |
| 개인 비서          | `NousResearch/hermes-agent`               | 266,149 | Python     | 50줄 while 루프를 캐시 안정성 · 선행 영속화 · 압축으로 감쌈. 전체 118만 줄             |
| 개인 비서          | `HKUDS/nanobot`                           | 50,341  | Python     | 버스 → 세션별 FIFO → runner. 구조가 가장 읽기 쉬움. 상한 200 + 마무리 호출             |
| 개인 비서 (메모리) | `letta-ai/letta` → `letta-ai/letta-code`  | 25,549  | TypeScript | 서버가 루프를 가진 프로토콜형. 벡터 메모리를 버리고 마크다운 파일 메모리로 이동        |
| 코딩 하네스        | `anomalyco/opencode` (구 sst/opencode)    | 229,237 | TypeScript | Effect + 이벤트 소싱으로 재작성. 상한 도달 시 도구 호출만 막고 요약 요청               |
| 코딩 하네스        | `openai/codex`                            | 136,489 | Rust       | `core/src` 15만 줄. 병렬 가능 도구는 read lock, 나머지는 write lock                    |
| 코딩 하네스        | `earendil-works/pi` (구 badlogic/pi-mono) | 123,926 | TypeScript | **작은 루프의 본보기.** `agent-loop.ts` 952줄, 골격은 140줄                            |
| 코딩 하네스        | `aaif-goose/goose` (구 block/goose)       | 57,006  | Rust       | operation 25개짜리 상태기계. 저장된 대화에서 다음 행동을 유도                          |
| SDK                | `mastra-ai/mastra`                        | 29,824  | TypeScript | 루프 자체가 워크플로. 메모리 4종, processor 로 가드레일                                |
| SDK                | `vercel/ai`                               | 28,217  | TypeScript | `ToolLoopAgent`, `stopWhen`, `prepareStep`. 세션 저장은 호출자 몫                      |
| SDK                | `openai/openai-agents-js`                 | 4,031   | TypeScript | Agent / Runner / Session / handoff / guardrail. Python 판은 30,880                     |
| SDK                | `anthropics/claude-agent-sdk-typescript`  | 1,905   | TypeScript | **루프 소스 비공개** (Claude Code 바이너리 안). 타입 선언과 문서만 분석                |
| SDK                | `langchain-ai/langgraphjs`                | 3,427   | TypeScript | 상태 그래프 + 체크포인터 + interrupt                                                   |

공식 가이드도 함께 읽었다: Anthropic 의 Building effective agents, Effective context engineering, Writing effective tools, Demystifying evals, The components of agent memory(2026-11-06) 등 9편과 OpenAI 의 A practical guide to building agents.

## 2. 다들 같은 뼈대로 수렴했다

이름은 달라도 구조는 같다. 13개 레포와 가이드가 공통으로 가진 것:

| #   | 구성요소                      | 내용                                                                                                             | 대표 근거                                              |
| --- | ----------------------------- | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| 1   | 상태 없는 에이전트 설정       | instructions + model + tools 는 평범한 객체, 실행 루프와 분리                                                    | OpenAI `Agent`/`Runner`, AI SDK, Mastra                |
| 2   | 모델이 끝내는 루프            | "tool call 이 없으면 종료"가 유일한 정상 종료. 단위 이름은 turn 또는 step                                        | pi, OpenClaw, hermes, nanobot, codex, opencode 전부    |
| 3   | 유한한 상한과 우아한 마무리   | 반복 상한 · 예산 · 취소. 상한에 닿으면 도구 없이 한 번 더 불러 지금까지로 답하게 함                              | nanobot(200), opencode(`tool_choice none`), OpenAI(10) |
| 4   | stop reason 을 빠짐없이 분기  | `tool_use` 계속, `max_tokens` 로 잘린 tool call 은 실행 금지, `refusal` 은 재시도 없이 노출, `pause_turn` 재요청 | pi, opencode                                           |
| 5   | 추가 전용 트랜스크립트        | 세션은 append-only 로그. 모델 응답 블록을 그대로 저장하고, 부수효과보다 먼저 쓴다                                | OpenClaw `transcript_events`, hermes, codex rollout    |
| 6   | 짝 없는 tool call 정산        | 중단 · 크래시 뒤 결과 없는 tool call 마다 에러 결과를 합성해 채움                                                | pi, opencode, goose, hermes, nanobot                   |
| 7   | 캐시 프리픽스 고정            | 시스템 프롬프트와 도구 목록은 바이트 단위로 고정. 시각 · 포트폴리오 같은 턴별 값은 메시지로                      | hermes, goose `<turn-context>`, codex, nanobot         |
| 8   | 도구 파이프라인               | 스키마 검증 → 실행 → 실패는 예외가 아니라 모델이 읽는 결과. 결과 크기 상한. 읽기 전용은 병렬                     | pi, 모든 SDK                                           |
| 9   | 타입 있는 이벤트 스트림       | 턴 시작 · 텍스트 delta · 도구 시작/끝 · 턴 종료(usage) · 오류. 모든 채널이 같은 스트림을 소비                    | pi 10종, OpenClaw 10종                                 |
| 10  | 세션당 실행 하나 + 입력 큐    | 실행 중 들어온 입력은 큐로. step 경계에 넣거나(steer) 끝난 뒤 넣는다(follow-up)                                  | pi, opencode, codex, goose                             |
| 11  | 세션과 분리된 메모리          | 항상 주입되는 작은 코어 + 검색 가능한 나머지. 벡터 DB 는 대부분 버렸다                                           | hermes 2,200자, letta-code, nanobot                    |
| 12  | cron 은 평범한 턴             | 같은 프로세스 스케줄러가 같은 루프를 부르고, 결과 전달은 모델이 아니라 시스템이 한다                             | 네 비서 전부. heartbeat 는 cron 으로 흡수              |
| 13  | 스크립트된 가짜 모델로 테스트 | 모델 호출을 함수 하나로 주입받고, 테스트는 정해진 응답을 차례로 내주는 가짜를 쓴다                               | pi `faux.ts`, opencode `TestLLM`                       |

수렴하지 **않은** 것: handoff(제어 이전) 는 OpenAI 만 가진다. 가드레일은 전용 추상화가 아니라 훅의 한 용법이 되는 중이다. eval 을 런타임에 내장한 곳은 Mastra 뿐이지만 양사 가이드는 필수로 본다.

어느 레포에도 **없던** 것: 턴 단위 비용 예산(Claude SDK 의 `maxBudgetUsd` 만 예외), 그리고 "모델이 말한 숫자가 도구 결과에 있던 숫자인가"를 검사하는 가드. 금융 비서에는 둘 다 필요한데 참고할 선례가 없다.

## 3. 규모에 대한 사실

- 인기 레포는 전부 한 사람이 읽을 수 있는 크기를 넘었다: OpenClaw `src/agents` 54만 줄, hermes 118만 줄, codex `core` 15만 줄, "lightweight" 를 내세운 nanobot 도 14만 줄.
- 두께의 대부분은 FinClaw 에 없는 문제에서 나온다: 다중 프로바이더(OpenClaw `packages/ai` 3.9만 줄), 셸 승인 · 샌드박스(hermes 7.7천 줄), 다중 클라이언트 게이트웨이, 크래시 복구.
- 공통된 실패 양상은 "루프는 작게 시작했는데 예외 경로마다 파일이 하나씩 생겼다"는 것이다 (hermes `turn_*.py` 30여 개, letta 의 루프 4벌). 루프를 한 벌만 두고 채널 · cron 이 모두 그것을 부르게 하는 것이 가장 값싼 예방이다.
- Anthropic 하나 · 사용자 하나로 좁히면 루프 골격은 200~300줄에 들어간다 (pi 의 골격이 140줄).

## 4. FinClaw 채점 — 지금과 목표

레인 3 이 정리한 13항목 체크리스트(항목당 0~2점)로 **현재 main** 을 채점했다.

| #   | 기준                                              | 지금        | 이유                                                             |
| --- | ------------------------------------------------- | ----------- | ---------------------------------------------------------------- |
| 1   | 에이전트 설정이 무상태이고 루프와 분리            | 1           | 설정은 분리돼 있으나 루프가 우리 코드가 아니다                   |
| 2   | 루프가 turn 단위로 돌고 stop reason 을 전부 분기  | 0           | `claude` CLI 안에서 일어난다                                     |
| 3   | 반복 상한 + 비용 예산 + 취소 + 도구 타임아웃      | 1           | 상한 · 취소 · 타임아웃은 CLI 플래그로. 예산 없음                 |
| 4   | 종료 사유가 타입으로 구분, 실패에도 usage 가 남음 | 1           | `done`/`error{reason}` 는 있으나 실패 시 usage 가 비는 경로 있음 |
| 5   | 도구가 스키마로 검증되고 실패가 결과로 돌아감     | 1           | 레지스트리는 갖췄으나 MCP 를 거쳐 CLI 가 부른다                  |
| 6   | 한 턴의 여러 tool call 을 병렬 실행               | 0           | CLI 가 결정                                                      |
| 7   | 도구 결과 크기 상한과 범위 축소 안내              | 1           | 10만 자 잘라내기만 있음                                          |
| 8   | 세션이 append-only 로그, 블록 전체 보존           | 0           | 텍스트만 저장. 진짜 트랜스크립트는 CLI 세션 파일                 |
| 9   | 프리픽스가 안정적이고 가변 컨텍스트가 뒤에 있음   | 1           | 구조는 맞지만 캐시 적중을 확인할 수 없다                         |
| 10  | 모든 채널이 하나의 이벤트 스트림을 소비           | 2           | 맥 앱 · Discord · TUI · cron 이 같은 `AgentEvent`                |
| 11  | run > turn > 도구 단위 추적과 토큰 · 비용 기록    | 1           | run 단위 감사만 있음                                             |
| 12  | 회귀 eval 세트                                    | 0           | 없음                                                             |
| 13  | 확장 슬롯 (축약 · 메모리 · 승인 · 서브에이전트)   | 1           | 메모리 · 서브에이전트 자리는 있음                                |
|     | **합계**                                          | **10 / 26** |                                                                  |

목표는 1~12 를 2점으로 올리는 것이고, 그 방법이 [`../agent-core.md`](../agent-core.md) 다.

## 5. 가져올 것 · 미룰 것 · 안 할 것

**가져온다 (v1)**

1. 루프 한 벌: `tool call 이 없으면 종료`, stop reason 전부 분기, 상한 도달 시 도구 호출을 막은 마무리 호출.
2. append-only 트랜스크립트: Anthropic 블록을 그대로 SQLite 에 저장, 매 step 저장, 짝 없는 tool call 정산.
3. 프리픽스 고정: 시스템 프롬프트 · 도구 목록 고정, 턴 컨텍스트는 user 메시지에, `cache_read_input_tokens` 기록.
4. 도구: 검증 → 실행 → 실패는 `is_error` 결과, 읽기 전용이라 전부 병렬, 한 턴의 결과는 메시지 하나에.
5. 종료 사유 타입 + 반복 상한 + 비용 예산 + 취소.
6. 이벤트 유니온 하나 (지금 것을 유지 · 보강).
7. 가짜 스트림 함수로 루프 테스트, 그리고 작은 eval 세트.
8. cron 은 같은 루프의 별도 run. 모델을 부르기 전에 코드로 조건을 먼저 본다.

**미룬다 (필요가 관측되면)**: 히스토리 축약(서버 측 compaction 부터), 노트형 코어 메모리와 백그라운드 통합, 쓰기 도구용 승인 중단, 서브에이전트, 실행 중 입력 끼워넣기(steer), tool search.

**하지 않는다**: handoff · 에이전트 네트워크, 그래프/워크플로 엔진, 다중 프로바이더 추상화, 교체 가능한 저장소 인터페이스, 셸 승인 · 샌드박스, 플러그인 훅 체계, LLM 입력 분류기, OpenTelemetry 익스포터, 벡터 메모리 확장.

## 6. 한계

- Claude Agent SDK 의 루프는 소스가 없어 타입 선언과 문서로만 봤다.
- 큰 레포는 전체가 아니라 루프 · 런타임 경로만 읽었다. 각 보고서 끝에 "찾지 못한 것" 목록이 있다.
- Messages API 세부(서버 측 compaction, context editing, mid-conversation system 메시지)는 SDK 번들 문서 기준이다. 구현 전에 원문으로 확인한다.
