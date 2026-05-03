# Interface & Channels Comparison

## 한 줄 결론

**Interface & Channels 유사도 51% — 게이트웨이/자동화는 충실히 모방했으나 채널 다양성 + ACP/Canvas/Plugin-SDK/Pairing/Wizard/MCP 가 모두 부재. 사용자 1인 제약으로 정당한 단순화(Adapted) 가 5건, 의도/근거 불충분한 Missing 이 7건.**

---

## OpenClaw → FinClaw 매핑 매트릭스

| #   | OpenClaw 패턴/모듈                                               | OpenClaw 경로                                                                                                                                                                        | FinClaw 대응                                                                                                 | FinClaw 경로                                                                                                       | 라벨           | 본질성       | 비고                                                                                                                                                                                                                                                                                               |
| --- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ | -------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | JSON-RPC over WebSocket gateway                                  | `src/gateway/server.ts`, `server-methods-list.ts`                                                                                                                                    | JSON-RPC over WS gateway                                                                                     | `packages/server/src/gateway/{server,router,rpc/index}.ts`                                                         | Faithful       | Critical     | dispatcher/registry/auth 분리 동일                                                                                                                                                                                                                                                                 |
| 2   | RPC 메서드 카탈로그                                              | `gateway/server-methods-list.ts:5-100` (90+ methods)                                                                                                                                 | `rpc/methods/*.ts` (37 methods)                                                                              | `packages/server/src/gateway/rpc/methods/{agent,agent-runs,chat,config,finance,memory,schedule,session,system}.ts` | Adapted        | Critical     | 핵심 카테고리(chat/agent/session/config/health) 모두 존재. node.pair/device.pair/talk/voicewake/skills/usage 누락                                                                                                                                                                                  |
| 3   | Gateway 이벤트 카탈로그                                          | `gateway/server-methods-list.ts:103-122` (19 events)                                                                                                                                 | `BroadcastChannel` 4개                                                                                       | `packages/types/src/notification.ts:43`, broadcaster 호출                                                          | Misimplemented | Important    | OpenClaw 는 19개 이벤트 + 명명 카탈로그 / FinClaw 는 `'config.updated' \| 'session.event' \| 'system.status' \| 'market.tick'` 만 타입 선언, 실제는 `'portfolio.changed'`, `'schedule.completed'` 등 ad-hoc 채널명도 broadcaster 에 전달됨 (finance.ts:96, delivery.ts:96) — 타입과 실 사용 불일치 |
| 4   | OpenAI-호환 endpoint                                             | `src/gateway/openai-http.ts`, `openresponses-http.ts`, `openai-responses.schema.ts`                                                                                                  | `gateway/openai-compat/{router,adapter}.ts`                                                                  | `packages/server/src/gateway/openai-compat/router.ts:62-72`                                                        | Misimplemented | Important    | router 가 stream 모드에서 `data: [DONE]` 만 즉시 송출하고 `// TODO(Phase 12+): runner.execute` 로 미연동, non-stream 은 501 — OpenClaw 는 실제로 동작                                                                                                                                              |
| 5   | 인증: bearer/api-key/query-token                                 | `src/gateway/auth.ts`, `device-auth.ts`, `credentials.ts`, `startup-auth.ts`, `http-auth-helpers.ts` 등 10+ files                                                                    | `gateway/auth/{index,api-key,token,rate-limit}.ts` 4 files                                                   | `packages/server/src/gateway/auth/index.ts:13-60`                                                                  | Adapted        | Critical     | OpenClaw 의 device-auth/credential precedence/role-policy 깊이를 단순 3-방식(bearer/?token/X-API-Key)으로 축소. 사용자 1인 환경에서 정당                                                                                                                                                           |
| 6   | Cron / 스케줄러                                                  | `src/cron/service.ts` + 33 모듈 (delivery, normalize, parse, run-log, schedule, session-reaper, stagger, store, validate-timestamp)                                                  | `automation/{scheduler,cron,delivery}.ts` 5 files                                                            | `packages/server/src/automation/scheduler.ts:69-351`                                                               | Faithful       | Critical     | 1분 폴러, due-find, lane 직렬화, 연속 실패 임계 + auto-disable, onRunComplete delivery 콜백 (scheduler.ts:298-344) 패턴 유지. OpenClaw 의 stagger/session-reaper/run-log 같은 보조 모듈은 누락이지만 핵심 골격은 동일                                                                              |
| 7   | 다중 채널 (Discord/Slack/Telegram/WhatsApp/iMessage/Line/Signal) | `src/{discord,slack,telegram,whatsapp,imessage,line,signal}/` 7 디렉토리 / 417 files                                                                                                 | Discord 단일 (37 files)                                                                                      | `packages/channel-discord/src/`                                                                                    | Adapted        | Important    | 사용자 1인 + 금융 도메인 한정으로 Discord 1개 정당. CLAUDE.md/use_case 에 명시. 단 channels registry 추상화는 유지 (`channels/registry.ts`) — 향후 추가 여지                                                                                                                                       |
| 8   | 채널 추상화 (`channels/` 공통)                                   | `src/channels/` 41 files (allowlists, ack-reactions, command-gating, mention-gating, sender-identity, typing, dock, registry...)                                                     | `channels/{registry,dock,chat-type,typing,init,index}.ts` 6 files                                            | `packages/server/src/channels/registry.ts`                                                                         | Adapted        | Important    | dock/registry/typing 은 유지. allowlist/mention-gating/command-gating/sender-label 등 멀티-사용자 가시성 모듈은 누락 (1인 환경에서 의도)                                                                                                                                                           |
| 9   | TUI/CLI/Terminal 3분할                                           | `src/cli/` (28 files) + `src/tui/` (24 files) + `src/terminal/` (14 files) — 314 LOC files                                                                                           | TUI 단일 (Ink) 4 files                                                                                       | `packages/tui/src/{App.tsx,ChatView,DashboardView,StatusBar,gateway-client}.ts`                                    | Adapted        | Important    | OpenClaw 의 browser-cli/clawbot-cli/channels-cli/acp-cli 등 다중 진입점은 누락. 사용자 1인 환경에서 ink 단일 TUI 로 정당                                                                                                                                                                           |
| 10  | Web UI                                                           | `src/web/` 80 files                                                                                                                                                                  | `packages/web/src/views/{alerts,market,portfolio,settings,transaction-form,schedule-form}.ts` 14 files + Lit | `packages/web/src/{app,markdown,main}.ts`                                                                          | Adapted        | Important    | Lit + custom elements 로 단순화. 금융 도메인 view 추가 (transaction-form, portfolio). markdown.ts 는 marked + DOMPurify (web/src/markdown.ts:13-40). OpenClaw 의 별도 `ui/` (1.8MB) 미러 부재                                                                                                      |
| 11  | ACP 프로토콜 (`@agentclientprotocol/sdk`)                        | `src/acp/{server,client,translator,event-mapper,session-mapper,commands}.ts` 14 files                                                                                                | 부재                                                                                                         | —                                                                                                                  | Missing        | Important    | plans/phase14/plan.md 에 ACP 언급은 있으나 미구현. ACP 는 외부 IDE/에이전트와의 표준 인터페이스 — 사용자 1인 환경에서도 Cursor/Zed 통합 가치 존재. 누락 근거 명시 부족                                                                                                                             |
| 12  | Canvas-Host (Artifacts/A2UI)                                     | `src/canvas-host/{server,a2ui,file-resolver}.ts` 5 files                                                                                                                             | 부재                                                                                                         | —                                                                                                                  | Missing        | Nice-to-have | ChatGPT Canvas / Claude Artifacts 류. FinClaw 는 차트/포트폴리오 view 가 정적 lit element 로 분리되어 있어 우회 — 누락 정당화 가능하나 명시 근거 없음                                                                                                                                              |
| 13  | Plugin-SDK + Plugin Registry                                     | `src/plugin-sdk/` (15 files) + `src/plugins/` (16 files) — 31 files                                                                                                                  | `plugins/{manifest,loader,registry,hooks,event-bridge,discovery,errors}.ts` 9 files                          | `packages/server/src/plugins/index.ts:1-30`, `manifest.ts`                                                         | Adapted        | Important    | Zod v4 기반 매니페스트 (manifest.ts:5-16) + slot/registry/hook 구조는 모방. 단 OpenClaw 의 `plugin-sdk` (외부 패키지로 export) + `extensions/` 38개 실 플러그인 부재 — FinClaw 측 플러그인 0개                                                                                                     |
| 14  | Extensions 카탈로그                                              | `extensions/` 38 디렉토리 (bluebubbles, copilot-proxy, googlechat, matrix, msteams, nostr, signal, slack, telegram, whatsapp 등)                                                     | 부재                                                                                                         | —                                                                                                                  | Missing        | Nice-to-have | 1인용 + 금융 도메인 한정으로 정당화 가능 (Adapted) 하나 plugin 시스템을 만들고 0개 사용 — 회수 효율 의문                                                                                                                                                                                           |
| 15  | Wizard / Onboarding                                              | `src/wizard/{onboarding,onboarding.gateway-config,onboarding.completion,clack-prompter,prompts,session}.ts` 13 files                                                                 | 부재 (config 파일 직접 편집)                                                                                 | —                                                                                                                  | Missing        | Important    | 사용자 1인이라도 첫 부팅 시 API key/profile 설정은 필요. 우발 누락 가능성 (근거 부족)                                                                                                                                                                                                              |
| 16  | Pairing (Device/Node)                                            | `src/pairing/{pairing-store,pairing-messages,setup-code}.ts` 8 files                                                                                                                 | 부재                                                                                                         | —                                                                                                                  | Missing        | Nice-to-have | 멀티 디바이스 동기화 — 1인 환경에서도 desktop/mobile 동기화 가치는 있으나 모바일 비대상 명시되어 있어 정당화 가능 (Adapted 후보). CLAUDE.md 기준 모바일 비대상으로 분류                                                                                                                            |
| 17  | Security / 정책 (`src/security/`)                                | 25 files (audit-tool-policy, audit-fs, dangerous-tools, dangerous-config-flags, dm-policy-shared, external-content, skill-scanner, windows-acl)                                      | 부재 (gateway/auth 의 인증 4 files 만)                                                                       | —                                                                                                                  | Missing        | Important    | OpenClaw 의 audit-\* 는 도구 실행 위험성 차단 — FinClaw 는 읽기 전용 도메인이라 일부 정당화 가능. dangerous-tools/skill-scanner 는 read-only 원칙으로 우회 가능                                                                                                                                    |
| 18  | MCP (Model Context Protocol) 클라이언트                          | OpenClaw 도 비완전: `src/acp/translator.ts:147,178` "ignoring N MCP servers" — ACP 가 MCP 서버를 받지만 비활성. memory/qmd-manager 에서 MCP 브리지 옵션 존재 (`memory.qmd.mcporter`) | 부재                                                                                                         | —                                                                                                                  | Diverged       | Important    | 양쪽 모두 MCP 클라이언트 수용 자체는 부분적. OpenClaw 가 더 진척되어 있으나 결정적 아니므로 Diverged (의도적 차별화로 본다)                                                                                                                                                                        |
| 19  | 출력 포맷터 (markdown / tts / media)                             | `src/markdown/` (12 files) + `src/tts/` (5 files) + `src/media/` (28 files)                                                                                                          | `packages/web/src/markdown.ts` (1 file) + 부재                                                               | `packages/web/src/markdown.ts:13-40`                                                                               | Adapted        | Nice-to-have | marked + DOMPurify 단일 함수. tts/media 부재는 음성/멀티미디어 비대상으로 정당. markdown 멀티-채널 일관 포매팅은 누락 (web 전용)                                                                                                                                                                   |
| 20  | Hot-reload / Health / Rate-limit / CORS                          | `src/gateway/config-reload.ts`, `health.ts`, 기타 산재                                                                                                                               | `gateway/{hot-reload,health,rate-limit,cors,access-log}.ts` 5 files + 모두 통합 export                       | `packages/server/src/gateway/index.ts:40-58`                                                                       | Faithful       | Important    | 오히려 FinClaw 측이 더 정돈됨 — barrel index.ts 에서 일괄 export, OpenClaw 는 개별 산재                                                                                                                                                                                                            |
| 21  | Schedule UI (Web)                                                | OpenClaw 측 명시적 schedule view 없음 — cron RPC + ad-hoc UI                                                                                                                         | `web/src/views/schedule-form.ts` + `schedule.*` RPC 9 methods                                                | `packages/server/src/gateway/rpc/methods/schedule.ts:386-394`                                                      | Faithful       | Important    | 오히려 FinClaw 가 schedule.create/list/update/delete/runNow/history/disable/enable/testCron 9 메서드 + UI 폼까지 정돈 — OpenClaw 보다 깔끔                                                                                                                                                         |

---

## 카테고리별 분석

### Faithful (충실 모방)

- **JSON-RPC + WebSocket gateway** (#1): `gateway/server.ts` + `rpc/index.ts` 의 dispatcher/registry/auth 분리는 OpenClaw `server.impl.ts` 의 JSON-RPC over WS 와 동일 구조. broadcaster.broadcastToChannel (broadcaster.ts:120) 도 OpenClaw 의 채널 기반 fanout 모방.
- **Cron / Scheduler** (#6): `automation/scheduler.ts:69-351` 의 1분 폴러 → due 검색 → lane 직렬화 → onRunComplete delivery 콜백 → 연속 실패 자동 비활성 패턴은 OpenClaw `cron/service.ts` 와 골격 일치. 오히려 더 명료.
- **Hot-reload/Health/CORS/Rate-limit** (#20): `gateway/index.ts:40-58` 의 일괄 export 는 OpenClaw 의 산재된 구현을 재정돈한 형태로 Faithful 이상.
- **Schedule RPC + Web UI** (#21): `rpc/methods/schedule.ts` 의 9개 메서드 + `web/src/views/schedule-form.ts` UI 는 OpenClaw 의 cron RPC 보다 사용자 면이 더 정돈됨.

### Adapted (정당한 단순화)

- **RPC 메서드 카탈로그** (#2): OpenClaw 90+ → FinClaw 37. 사용자 1인 + 금융 도메인 + 모바일 비대상으로 node.pair/device.pair/talk/voicewake/skills 카테고리 누락 정당. 핵심(chat/agent/session/config/health) 보존.
- **인증** (#5): OpenClaw 10+ files → FinClaw 4 files. device-auth/credential precedence 등 멀티 사용자/디바이스 모듈은 1인 환경에서 불필요.
- **다중 채널** (#7): 7 채널 → 1 채널. 사용자 사용 환경(Discord 봇 단일) + 금융 도메인 한정으로 정당. **단 channels/registry 추상화는 유지하여 확장 여지 보존** (registry.ts:7-30).
- **TUI/CLI/Terminal** (#9): 3분할 314 files → 단일 ink TUI 4 files. OpenClaw 의 browser-cli/acp-cli/clawbot-cli 같은 다중 진입점은 1인 환경에서 가치 낮음.
- **Web UI** (#10): 80 files → 14 files + Lit. 금융 도메인 view (portfolio/transaction-form) 추가하여 도메인 적응.
- **Plugin 시스템** (#13): plugin-sdk + 38 extensions → loader/manifest/registry/hooks 9 files + 0 extensions. 골격은 모방하나 실 플러그인 0개 — 회수율 평가 별도.
- **출력 포매터** (#19): markdown/tts/media 45 files → markdown 1 file. tts/media 비대상으로 정당화 가능, 단 멀티-채널 일관 포매팅 부재.

### Diverged (의도적 차별화)

- **MCP 클라이언트** (#18): 양쪽 모두 부분 구현이지만 OpenClaw 가 ACP 측에서 MCP 서버 수신 → ignore 패턴이고, FinClaw 는 시작도 안 함. plans/phase29 에 MCP 언급 — 향후 작업으로 명시되어 있다는 점에서 Diverged 로 본다 (현 시점에서는 의도된 선택).

### Misimplemented (오해 / 잘못 모방)

- **Gateway 이벤트 카탈로그** (#3): `BroadcastChannel = 'config.updated' | 'session.event' | 'system.status' | 'market.tick'` 4개로 타입 선언 (`packages/types/src/notification.ts:43`) 하지만 실제 broadcaster.broadcastToChannel 호출에서는 `'portfolio.changed'` (finance.ts:96), `'schedule.completed'` (delivery.ts:96), `'config.updated'` (hot-reload.ts:82) 등 5+ 채널이 ad-hoc 으로 사용됨. 타입과 실 사용의 불일치는 OpenClaw 의 명명된 GATEWAY_EVENTS 카탈로그 패턴(server-methods-list.ts:103) 의 본질("어떤 이벤트가 송출 가능한지 단일 출처") 을 놓친 형태.
- **OpenAI-호환 endpoint** (#4): `gateway/openai-compat/router.ts:62-72` 가 stream 모드에서 `data: [DONE]` 즉시 송출 + `// TODO(Phase 12+): runner.execute` 미연동, non-stream 은 501 응답. OpenClaw 의 동일 패턴은 실제 모델 실행으로 연결됨. **구조는 모방했으나 작동하지 않는 모방** — Misimplemented.

### Missing (누락)

**의도된 누락 (정당화 근거 있음):**

- **Pairing (Device/Node)** (#16): CLAUDE.md `project_use_case.md` 에 모바일 비대상 명시. 1인 desktop 환경에서 device pairing 가치 낮음.
- **다중 채널 일부**: Slack/Telegram/WhatsApp/iMessage/Line/Signal — 사용자 환경이 Discord 단일이라 명시되어 정당. (단 위에서는 Adapted 로 분류 — 추상화 보존했기 때문)

**우발적/근거 부족 누락:**

- **ACP 프로토콜** (#11): plans/phase14 에 언급은 있으나 미구현. Cursor/Zed 같은 외부 IDE 통합 가치 존재. 누락의 명시적 근거 없음. **Important / 우발 (근거 부족).**
- **Wizard / Onboarding** (#15): 1인 환경이라도 첫 부팅 시 API key/profile 설정은 필요. 현재는 config 파일 직접 편집 의존 — 사용자 가치 손실. **Important / 우발 (근거 부족).**
- **Security 깊이** (#17): 25 files → 4 files. read-only 원칙으로 일부 정당화는 가능하나 dm-policy/external-content/skill-scanner 같은 정책 모듈 부재는 보안 가치 손실. **Important / 부분 정당.**
- **Canvas-Host / Artifacts** (#12): 1인 + 금융 도메인이라도 차트 인터랙티브 표현/도구 산출물 시각화 가치 존재. 누락 근거 없음. **Nice-to-have / 우발.**
- **Extensions 카탈로그** (#14): plugin 시스템을 만들고 0개 사용 — 우발적 미사용에 가까움. **Nice-to-have / 우발.**
- **Multi-channel 출력 포매터 일관성**: tts/media 부재는 정당하지만 channel 별 markdown 포매팅 분기(예: Discord 2000자 제한 vs Web markdown) 가 ad-hoc (delivery.ts:39-45) — OpenClaw `markdown/whatsapp.ts` 같은 채널 전용 포매터 없음. **Important / 우발.**

---

## 측정값

| 측정 항목                          | OpenClaw                                                          | FinClaw                | 압축률   |
| ---------------------------------- | ----------------------------------------------------------------- | ---------------------- | -------- |
| 채널 디렉토리 수                   | 8 (channels/discord/slack/telegram/whatsapp/imessage/line/signal) | 1 (channel-discord)    | 12.5%    |
| 비-discord 채널 ts files           | 417                                                               | 0                      | 0%       |
| Discord 채널 ts files              | 59                                                                | 37                     | 63%      |
| Gateway ts files                   | 276                                                               | 53                     | 19%      |
| RPC 메서드 수                      | ~90 (server-methods-list.ts)                                      | 37                     | 41%      |
| Gateway 이벤트 명명 카탈로그       | 19 events (GATEWAY_EVENTS)                                        | 4 declared + 1+ ad-hoc | ≤30%     |
| Cron/automation ts files           | 33 (non-test) / 55 (incl. tests)                                  | 5                      | 9-15%    |
| TUI+CLI+Terminal ts files          | 314                                                               | 12 (tui only)          | 4%       |
| Web UI ts files                    | 80 (src/web)                                                      | 20 (packages/web)      | 25%      |
| Auth/Security ts files             | 25 (security) + 10+ (gateway/auth-\*) ≈ 35                        | 4                      | 11%      |
| Plugins+plugin-sdk+extensions      | 31 + 38 ext = 69                                                  | 9 + 0 = 9              | 13%      |
| ACP files                          | 14                                                                | 0                      | 0%       |
| Canvas-host files                  | 5                                                                 | 0                      | 0%       |
| Wizard files                       | 13                                                                | 0                      | 0%       |
| Pairing files                      | 8                                                                 | 0                      | 0%       |
| Markdown/TTS/Media files           | 45                                                                | 1                      | 2%       |
| **Interface 영역 src 합계 (대략)** | ~1300 files                                                       | ~140 files             | **~10%** |

---

## 영역 유사도 점수 계산

가중치: Critical=3, Important=2, Nice-to-have=1
점수: Faithful=100, Adapted=75, Diverged=50, Missing=25, Misimplemented=10

| #   | 패턴                     | 라벨           | 본질성       | 점수 | 가중점수 |
| --- | ------------------------ | -------------- | ------------ | ---- | -------- |
| 1   | JSON-RPC over WS gateway | Faithful       | Critical(3)  | 100  | 300      |
| 2   | RPC 메서드 카탈로그      | Adapted        | Critical(3)  | 75   | 225      |
| 3   | Gateway 이벤트 카탈로그  | Misimplemented | Important(2) | 10   | 20       |
| 4   | OpenAI-호환 endpoint     | Misimplemented | Important(2) | 10   | 20       |
| 5   | 인증                     | Adapted        | Critical(3)  | 75   | 225      |
| 6   | Cron / 스케줄러          | Faithful       | Critical(3)  | 100  | 300      |
| 7   | 다중 채널                | Adapted        | Important(2) | 75   | 150      |
| 8   | 채널 추상화              | Adapted        | Important(2) | 75   | 150      |
| 9   | TUI/CLI/Terminal         | Adapted        | Important(2) | 75   | 150      |
| 10  | Web UI                   | Adapted        | Important(2) | 75   | 150      |
| 11  | ACP 프로토콜             | Missing        | Important(2) | 25   | 50       |
| 12  | Canvas-Host              | Missing        | Nice(1)      | 25   | 25       |
| 13  | Plugin-SDK               | Adapted        | Important(2) | 75   | 150      |
| 14  | Extensions 카탈로그      | Missing        | Nice(1)      | 25   | 25       |
| 15  | Wizard / Onboarding      | Missing        | Important(2) | 25   | 50       |
| 16  | Pairing                  | Missing        | Nice(1)      | 25   | 25       |
| 17  | Security 깊이            | Missing        | Important(2) | 25   | 50       |
| 18  | MCP 클라이언트           | Diverged       | Important(2) | 50   | 100      |
| 19  | 출력 포매터              | Adapted        | Nice(1)      | 75   | 75       |
| 20  | Hot-reload/Health/CORS   | Faithful       | Important(2) | 100  | 200      |
| 21  | Schedule UI + RPC        | Faithful       | Important(2) | 100  | 200      |

- 가중치 합: 41
- 가중점수 합: 2,640
- **가중 평균 = 2,640 / 41 = 64.4%**

> 단 Misimplemented 2건(이벤트 카탈로그 + OpenAI compat) 이 본질에서 작동을 안 하는 모방이라는 점을 감안해 영역 점수에 -10% 적용 → **최종 ≈ 54%**.
> 여기에 다중 채널/CLI/Web 의 압축률(평균 ~10%) 이 OpenClaw 인터페이스 다양성의 거시적 본질을 잃었다는 가중을 -3% 적용 → **최종 51%**.

### 패턴 수 라벨 분포

- **Faithful**: 4 (JSON-RPC gateway, Cron scheduler, Hot-reload/Health/CORS, Schedule RPC+UI)
- **Adapted**: 8 (RPC 카탈로그, 인증, 다중 채널, 채널 추상화, TUI/CLI, Web UI, Plugin-SDK, 출력 포매터)
- **Diverged**: 1 (MCP 클라이언트)
- **Missing**: 6 (ACP, Canvas-Host, Extensions 카탈로그, Wizard, Pairing, Security 깊이)
- **Misimplemented**: 2 (Gateway 이벤트 카탈로그, OpenAI-호환 endpoint)

총 21 패턴.

---

## 핵심 발견 요약

1. **Critical 영역(gateway/cron/auth)은 Faithful 또는 Adapted 로 양호** — 게이트웨이 골격, scheduler 1분 폴러, broadcaster, 4-방식 인증은 OpenClaw 의 핵심 모델 보존. 일부(`hot-reload`, `schedule.*`)는 오히려 FinClaw 가 더 정돈됨.
2. **본질을 놓친 모방 2건** — `BroadcastChannel` 타입과 실 사용 채널명 불일치(`finance.ts:96`, `delivery.ts:96`), OpenAI-compat router 가 미연동 stub(`openai-compat/router.ts:62-72`). 둘 다 "패턴은 흉내 냈으나 본질 작동 안 함" — 빠른 수정 가치.
3. **Wizard/ACP 누락은 의도적이라 보기 어려움** — 1인 환경 변호로 정당화하기엔 사용자 가치(첫 부팅 UX, 외부 IDE 통합) 가 명확. plans 에서 명시 결정 부재.
4. **다중 채널 압축은 정당** — Discord 1개로 축소했어도 channels/registry 추상화는 유지(`channels/registry.ts:7-30`) 하여 확장 여지 보존. 사용자 1인 환경 + 금융 도메인 한정으로 명시된 결정.
5. **Plugin 시스템의 회수율 의문** — Zod 매니페스트 + slot/registry/hook 구조는 OpenClaw 모방했지만 실제 플러그인 0개. "추상화는 만들고 사용은 안 함" — 한 번만 쓰는 코드에 추상화를 만들지 말 것 (CLAUDE.md §2) 위반 의심.
6. **출력 포맷의 채널 일관성 부재** — `automation/delivery.ts:36-49` 가 Discord 2000자 제한을 ad-hoc 처리. OpenClaw 의 `markdown/whatsapp.ts` 같은 채널-인디펜던트 포매터 추상화 부재.

---

## 반환

- **산출물 경로**: `/mnt/c/Users/박/Desktop/hi/FinClaw/_workspace/openclaw-similarity/interface-channels.md`
- **한 줄 결론**: Interface & Channels 유사도 51% — 게이트웨이/스케줄러 골격은 Faithful/Adapted 양호, 채널 다양성·ACP·Canvas·Wizard·Pairing·Plugin 회수가 Missing/Misimplemented.
- **라벨별 항목 수**: Faithful 4 / Adapted 8 / Diverged 1 / Missing 6 / Misimplemented 2 (총 21)
