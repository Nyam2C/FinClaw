# Phase 45 review — 레거시 전수 감사 + 삭제 (lane A~E)

> 작성 2026-11-26 · 브랜치 `feature/phase45-legacy-sweep` · base = main `16939cf` (phase44 머지)
> plan/todo 없이 진행한 sweep phase — 감사 리포트(`_workspace/legacy-audit/REPORT.md`, gitignore)가 plan 역할.
> 결론: **merge 가능.** 프로덕션 코드 35.6K → 26.4K LOC (**−26%**), 전체 −16,905 / +1,108 (338 파일).

## 1. 무엇을 했나

phase41(SDK 제거)·phase43(thin orchestrator) 이후에도 배선만 남아 실행되지 않던 코드를 전수 감사해 5개 묶음으로 삭제했다.

판정 근거가 된 사실 3개:

1. CLI adapter 는 `text_delta` → `usage` → `done` 만 낸다. 도구 호출은 CLI 내부 루프가 `/mcp` 로 직접 한다 → Runner 의 tool_use 루프·디스패처·tool 이벤트는 도달 불가.
2. `CliFailoverError` 는 폴백 트리거로 분류되지 않는다 → 모델 폴백·재시도 미발동.
3. MCP allow/deny 를 설정할 config 키가 없었다 → deny 된 도구는 켤 방법이 없었다.

| lane | 내용                                                                                                                                                                | 커밋                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| A    | SDK 시절 실행 엔진 (Runner 도구 루프·디스패처·모델 폴백/서킷브레이커·비용 추정·`chat.stream.tool_*`)                                                                | `525bf4e` `ee3de01`                                         |
| B    | 노출 불가 도구 (뉴스/시세 직접 도구, news-brief 시드) · MCP deny 6종(web_fetch·read_local_file·schedule_manage·set/remove_alert·brokerage_sync_holdings, 별도 커밋) | `2819708` `7987e26`                                         |
| C    | 가짜 응답 스텁 (config RPC·openai-compat·hot-reload·Discord 슬래시 커맨드·`!finclaw price/portfolio/alert`·죽은 CLI 명령)                                           | `5c23782` `05f9cb8`                                         |
| D    | 미완 스캐폴드/죽은 유틸 (process/·plugins 훅·config 미독 키·infra/types/storage 미사용·클라이언트 없는 RPC 8개·배럴)                                                | `276f1cc` `5d67602` `9b019bd` `986f0e3` `589c5bf` `452de68` |
| E    | 문서·설정·빌드 drift (README·.env.example·Dockerfile·시스템 프롬프트·test-env)                                                                                      | `d7cdc4d`                                                   |

## 2. 검증

- clean build · typecheck · lint · format 0.
- unit **960 pass** (134 files) · storage **140 pass** (22 files) · web vite build OK.
- 기존 실패 12건 해소: plugin 테스트 10건은 macOS `/tmp`→`/private/tmp` realpath 문제(테스트만 수정), file-read 2건은 도구와 함께 삭제.
- 실부팅 스모크: Discord 로그인만 stub 하고 `main.js` 끝까지 기동 — scheduler 시작, `/healthz` ok, `system.info` 34 메서드.

## 3. 사용자가 체감하는 변화

- 모델에 노출되는 도구: `get_current_datetime`, `route_task`, `list_alerts`, `get_alert_history` (+ 플러그인 `mcp:*`). 전부 read-only.
- config strict 스키마가 `gateway.auth.token`·`accessLog`·`rag.rerank.{enabled,topKFirst}`·`cliBackend`·`provider` 만 허용. 그 외 키는 부팅 거부.
- `DISCORD_APPLICATION_ID` 불필요. 슬래시 커맨드 제거.
- CLI `config`·`channel`·`stop`·`alert remove`·`market watch` 제거, TUI 설정 탭 제거.
- RPC 제거: `config.*`, `trace.*`, `audit.list`, `memory.getById`, `chat.history`, `chat.stop`, `session.reset/list`.
- `!finclaw status` 에서 비용/폴백 표시 제거 (모델별 호출 수는 유지).

## 4. 함께 해소된 것

- 서킷브레이커 영구 잠김(`fallback.ts` open 선검사) — 코드째 삭제.
- `config.example.json5` 부팅 실패 — 스키마에 맞게 재작성 + 검증 테스트.
- Dockerfile gateway manifest COPY 누락, `scripts/reindex.mjs` 깨진 import.
- `.env.example` 의 빈 `GATEWAY_JWT_SECRET=` (빈 문자열 secret 유발) → 주석 placeholder.

## 5. 남은 버그 (phase46 입력)

범위 밖이라 손대지 않았다. 전부 "절반만 이행된 CLI 런타임" 에서 나온다.

| #   | 증상                                                                                                                                                                              | 위치                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| B1  | 2턴째부터 RAG 기억·거래이력이 모델에 안 감 (전역 단일 CLI 세션 `--resume` + `systemPromptWhen:'first'`). 이력 중복 전송, 채널/cron 이 한 세션 공유, `/reset` 이 CLI 세션 미초기화 | agent `claude-cli/{adapter,runner,backends}.ts`, server `execution-adapter.ts` |
| B3  | `chat.stream.end` 미발송 → Web/TUI 응답 미확정                                                                                                                                    | agent `execution/runner.ts`, gateway `broadcaster.ts`                          |
| B4  | `!finclaw help/status/reset` 무응답 (commandStage 가 결과를 버림)                                                                                                                 | server `auto-reply/stages/command.ts`                                          |
| B5  | 매시 정각 cron 사실상 미실행 (stagger 재추첨)                                                                                                                                     | server `automation/scheduler.ts`                                               |
| B6  | gateway `0.0.0.0` + CORS `*` + `'dev-secret'` fallback                                                                                                                            | server `composition/constants.ts`                                              |
| B10 | `finclaw` CLI 의 RPC 명령이 인증 헤더 미첨부                                                                                                                                      | server `cli/gateway-client.ts`                                                 |
| B11 | CLI stdout 청크별 `toString()` — 한글 멀티바이트 경계 깨짐 가능                                                                                                                   | agent `claude-cli/spawn.ts`                                                    |
| B12 | MCP 세션 맵 TTL 없음 (미확인)                                                                                                                                                     | gateway `mcp/host.ts`                                                          |

## 6. 이월

- 이벤트 버스: 프로덕션 구독자 0 (emit 만 존재). 유지/삭제 결정 필요.
- KIS 명명 잔재(`source='kis'` CHECK 등) — 토스 연동 시 마이그레이션과 함께 rename.
- 플러그인 `mcp:*` 도구의 `require-approval` 이 실제로 막지 않음 (deny 만 동작) — B6 과 함께 검토.
