# Phase 46 킥오프 — 에이전트 코어 재설계 (현대적인 에이전트 아키텍처)

> 작성 2026-11-26 · base = main `01fbec2` (phase45 legacy sweep 머지 + CONTRIBUTING) · 브랜치 `feature/phase46-agent-core`
> 상태: **확정 — /goal 자율 모드에서 메인이 게이트 1·2 를 대행 승인 (2026-11-26). 사용자 사후 검토 대상.** 열린 질문의 해소는 `plan.md` §2.
> 선행 입력: `plans/phase45/review.md` §5(남은 버그 B1~B12), `_workspace/feature-research/agent-core/`(통합 계약 00 · 드라이버 사실 05 · scout L2/L3/L4 · 비교·추천 20).

## 사용자 목표

> "2. 이번에는 다시 우리 구조를 확인해서 기본적인 에이전트 형태로 만들어봐, 현대적인 에이전트 아키텍처로 만들고"

1번 목표("디코는 가능하게 하되 맥에서 알려주는 캐릭터 형식 챗봇")는 **phase47**. phase46 은 그 토대다 — 채널(Discord·Web·TUI·cron)과 무관한 **하나의 에이전트 런타임**과 **이벤트 스트림**을 만들고, 맥 클라이언트가 붙기 전에 로컬 인증·Discord 없는 부팅을 닫는다.

## 배경 — 지금 구조의 문제 (코드 실측)

phase41(SDK 제거)·phase45(레거시 삭제) 이후 실행 경로는 "절반만 CLI 로 옮겨진" 상태다.

- **실행 체인 4벌**이 같은 일을 한다: Discord(`execution-adapter.execute`) · Web/TUI(`executeForTui`) · cron(`scheduler.runOne`) · RPC `agent.run`. 서브에이전트(route_task → market_analysis)는 5번째 spawn 경로.
- 4벌이 **프로세스 전역 CLI 세션 1개**(`agent/providers/claude-cli/adapter.ts:17` `#cliSessionId`)를 공유한다 → **B1**: 2턴째부터 RAG 기억·거래이력이 모델에 안 감(`systemPromptWhen:'first'` 라 resume 시 시스템 프롬프트에 합성한 회상이 버려짐), 이력이 resume 과 재전송으로 이중, 채널·cron 이 한 세션에 섞임, `/reset` 이 CLI 세션을 못 지움.
- Runner 가 `done` 을 안 낸다 → **B3**: Web/TUI 응답이 확정되지 않음. `--output-format json` 단일 blob 이라 실제 토큰 스트리밍도 없다.
- **N1 (보안):** market_analysis 서브에이전트가 `--dangerously-skip-permissions` 로, `--tools ""` 없이 spawn 된다(`router/sub-agent.ts:27-33` → `DEFAULT_CLAUDE_BACKEND`). 외부 뉴스 본문(신뢰 불가 입력)이 Bash/Edit/Write 가능한 무승인 에이전트에 들어간다.
- **N2 (격리) — 사실로 확정 (L4 §8 실측):** 현 프로덕션 조건(설정 미차단·레포 cwd·`--append-system-prompt`)에서 금융 비서는 매 대화마다 사용자의 개발용 전역 `CLAUDE.md`·ponytail 훅 출력·프로젝트 하네스 지침 약 **12K 토큰**(cache write 12,125 tok, 플러그인 3·스킬 70여 개·`SessionStart` 훅 2개)을 받은 채 답한다. 격리 플래그 세트로는 776 tok(~1/15)로 줄고 지침 누수 0.
- 그 밖에 phase45 가 남긴 B4(명령 무응답)·B5(정각 cron 미실행)·B6(gateway `0.0.0.0`+CORS `*`+`'dev-secret'`)·B10(CLI 인증 헤더 없음)·B11(멀티바이트 깨짐)·B12(MCP 세션 누적), 신규 N3(도구 ctx identity 상수)·N5(Discord 인용 감사 유실)·N6(Web/TUI 에 RAG 없음)·N7(타임아웃 역전).

## 범위 요약

- **IN:** `claude -p` stream-json 드라이버(격리 플래그 강제) · `AgentRuntime.run() → AsyncIterable<AgentEvent>` 로 4 경로 수렴 · sessionKey 별 CLI 세션(resume·6h 회전·recap) · 턴별 컨텍스트를 user 메시지로 · 서브에이전트 격리 1-shot · 도구 이벤트 스트림 · `chat.abort`/`chat.reset` · Runner/ProviderAdapter 체인 삭제 · B4/B5/B6/B10/B11/B12/N1~N7 흡수 · Discord 없이 부팅 · 문서 동기화.
- **OUT (phase47+):** 맥 캐릭터 클라이언트, alerts websocket·proactive 알림, `messageId` 세그먼트, Discord 편집 스트리밍 프리뷰, `search_memory` 도구, 상주 CLI 프로세스, `CLAUDE_CONFIG_DIR`, agent.run memory 훅 존폐.
- **불변:** 구독 CLI 전용(API 키 없음) · read-only 도구·매수는 사람 · 모든 도구 호출은 `toolRegistry.execute` 경유 · 명시 선언 기반 기억(capture 정규식 5종) · `[mem:]`/`[txn:]` 인용 형식 · 1인 감사 가능 크기(순감) · mock-only 단위 테스트.

## 선행 조사

| 문서                                                                         | 내용                                                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `_workspace/feature-research/agent-core/00-integration-contract.md`          | 현재 4 경로 파일:라인 지도, 불변식 I1~I10, 버그 흡수 판정, 열린 질문 Q1~Q14   |
| `_workspace/feature-research/agent-core/05-driver-auth-facts.md`             | Agent SDK vs `claude -p` — 약관(C1)·전송 계층·stream-json 이벤트 실측         |
| `_workspace/feature-research/agent-core/10-scout-L2-oss-chatbots.md`         | claude CLI 위 OSS 챗봇(nanoclaw·happy·cc-connect 등)의 세션·스트림·격리       |
| `_workspace/feature-research/agent-core/10-scout-L3-lifecycle-protocols.md`  | 세션 수명(30일 스윕·autocompact·캐시 TTL), 이벤트 프로토콜(AG-UI·ACP)         |
| `_workspace/feature-research/agent-core/10-scout-L4-local-experiments.md`    | CLI 2.1.332 로컬 실측 — resume 실패·HTTP MCP·네이티브 서브에이전트·취소·G1/G5 |
| `_workspace/feature-research/agent-core/20-comparison-and-recommendation.md` | **설계 기준선** — 비교 매트릭스, 추천 아키텍처, Q1~Q14 확정, M1~M12, 리스크   |

## plan.md 가 반드시 결정할 것

1. **드라이버** — Agent SDK `query()` / `claude -p` 턴당 spawn / 상주 stream-json 프로세스. (Q1)
2. **agent.run RPC + LLM 출력→memory 훅** 존폐. (Q2)
3. **세션 전략** — 영구 resume / 유휴 회전 + recap / 매 턴 stateless. resume 실패 정책(Q3), 세션 id 를 누가 정하나.
4. **cron·agent.run 세션**(Q4), **Web/TUI 의 RAG·sessionKey**(Q5).
5. **스트림 이벤트 모양** — 도구 이벤트 노출(Q6), 최종 텍스트 정본(Q9), runId·messageId.
6. **동시성** — 전역 상한(Q7), 서브에이전트 포함 여부, per-session 직렬화, reset 경쟁(Q14).
7. **에러·타임아웃** — Discord 에러 전달(Q10), 타임아웃 체계(Q13), 취소 경로.
8. **로컬 보안** — gateway 바인딩·CORS·JWT secret·토큰 배포(Q11, B6/B10).
9. **격리** — cwd·설정 소스·CONFIG_DIR(Q12), 서브에이전트 네이티브화 여부.
10. synthesizer §7 미결 11개: runId 발급, 서브에이전트 abort 전파, 클라이언트의 미지 notification 처리, prepareTurn 위치, 에러 reason 타입, 전역 상한 구현, CORS·토큰 파일, 수치, conversations 저장 시점, `agent.test.ts` 재작성 범위, go/no-go 기록 위치.

## 산출물

이 kickoff + `plan.md` → (자율 모드: 메인 대행 승인) → `todo.md` 분해(`finclaw-phase-execute`) → 밀스톤 M1~M12 구현(밀스톤당 1커밋) → `review.md`.
