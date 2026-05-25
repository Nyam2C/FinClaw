# Phase 36 — main() composition root 모듈화 (옵션 A 확정)

> `main()` 898줄을 `src/composition/` 빌더 함수들로 분해한다. **순수 구조 리팩토링 — 동작·API·테스트 결과 불변이 성공 기준.** 패키지 추출(옵션 B/C)은 비대상(후속 phase, 감독 필요).

## 결정 (2026-05-25, 초안 옵션 A/B/C 중 확정)

- **옵션 A 확정**: `@finclaw/server` 한 패키지 유지, `main()` 의 wiring 블록을 `src/composition/*.ts` 빌더 함수로 추출. 의존 그래프·tsconfig references·패키지 경계 **불변**.
- **옵션 B/C(패키지 추출) 비대상**: gateway/pipeline 을 별 패키지로 빼는 건 의존 그래프·순환참조·build 파이프라인 재구성이 얽혀 무감독 머지에 부적합. 후속 phase37 후보로 남김. **옵션 A 는 C 의 밀스톤 A 이기도 하므로 no-regret** — A 를 해도 C 가 버려지지 않는다.

## ⚠️ 판단 기록 (CLAUDE.md §1 — 반론 명시)

- server 분할은 `project_known_limitations`·핸드오프에서 **"스코프 내 수용, 급하지 않음, 드라이버 생기면"** 으로 분류됨. 구체적 드라이버는 아직 없음(사용자 goal 지시가 트리거).
- `main()` 은 **startup 임계 경로**. 현 테스트 스탠스는 **mock-only, 실 키 부팅 e2e 없음**(핸드오프가 짚은 최대 미검증 리스크) → typecheck+build+unit+`main.test.ts` 로 "동작 불변" 을 **강하게 시사하나 완전 보증은 못 함**.
- **그래서 리스크 최소화 형태로 진행**: (1) 순수 추출·**호출 순서·side effect 순서 절대 보존**, (2) 밀스톤별 build+full test 게이트, (3) 부분 머지 허용(A 만, 또는 A+B), (4) 잔여 리스크(실 부팅 smoke)는 review 에 명시하고 키 보유자 수동 검증 권장.

## 현황 (코드 실측, 2026-05-25)

`main()` = `packages/server/src/main.ts:176-881` (전체 파일 898줄). wiring 블록(주석 번호와 대응):

| 블록                           | 라인    | 산출물                                                           | 주요 의존                                                                                                                     |
| ------------------------------ | ------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| 0~1 env/prompt                 | 177-191 | systemPrompt, anthropicKey, discord\*, gatewayPort               | -                                                                                                                             |
| 2 foundation                   | 193-235 | logger, lifecycle, finclawConfig, routing, routerHelper, storage | env                                                                                                                           |
| embedding                      | 237-259 | embeddingProvider                                                | storage, logger                                                                                                               |
| 3 discord login                | 264-272 | discordAdapter (async setup + lifecycle)                         | discordToken                                                                                                                  |
| 4 providers                    | 274-303 | sdkAdapter, routerLlm, providerAdapter, lanes, toolRegistry      | finclawConfig, anthropicKey                                                                                                   |
| scheduleRpc                    | 305-355 | scheduleRpc + registerGeneralTools                               | storage, toolRegistry                                                                                                         |
| 4a catalog                     | 357-361 | modelCatalog, modelAliasIndex, profileHealth                     | -                                                                                                                             |
| skills                         | 363-443 | marketHandle, newsHandle, alertHandle                            | toolRegistry, storage, keys, routerHelper, profileHealth, modelCatalog, discordAdapter, lifecycle                             |
| KIS                            | 445-523 | brokerageSyncService + news-brief seed                           | storage, toolRegistry, logger, finclawConfig                                                                                  |
| mcp/plugins                    | 525-559 | (toolRegistry policy + loadPlugins)                              | toolRegistry, finclawConfig, lifecycle                                                                                        |
| tracer/runner                  | 561-574 | tracer, runnerFactory                                            | storage, providerAdapter, lanes                                                                                               |
| exec adapter                   | 576-591 | adapter                                                          | runnerFactory, storage, toolRegistry, modelCatalog, profileHealth, routerLlm                                                  |
| pipeline                       | 593-653 | pipeline, memory services, reranker, summarizer                  | adapter, toolRegistry, storage, profileHealth, marketHandle, newsHandle, embeddingProvider, finclawConfig, sdkAdapter, tracer |
| router                         | 655-668 | MessageRouter + discord onMessage                                | pipeline, discordAdapter                                                                                                      |
| gateway                        | 670-816 | gatewayConfig, agentRunLane, scheduleLane, scheduler, gateway    | 거의 전부                                                                                                                     |
| purge/hotreload/delivery/start | 818-880 | timers, deliveryHook, start                                      | gateway, scheduler, storage                                                                                                   |

## 밀스톤 (순수 추출, 각 밀스톤 = 1 커밋, 동작 불변)

각 밀스톤: 빌더 함수로 추출 → `main()` 이 **같은 순서로** 호출 → `pnpm typecheck` + `pnpm build` + `pnpm test --run` + `pnpm test:storage` green. 추출한 블록의 코드는 그대로 옮기되 입력은 인자로, 산출물은 반환값으로.

- **A. scaffold + 저위험 leaf 추출** — `src/composition/` 신설. 가장 자기완결적인 블록 추출: `buildScheduleRpc(storage)` (305-353, storage 만 의존), `buildProviders({finclawConfig, anthropicKey})` (274-303). `defaultConfig`/`DEFAULT_MODEL` 상수는 `composition/constants.ts` 로(선택). main() 에서 호출로 대체.
- **B. skills/tools composition** — `composition/skills.ts`: `registerSkills(deps)` 가 general/market/news/alert/brokerage 등록 + mcp policy + plugins (355,363-559) 를 흡수, `{marketHandle, newsHandle, alertHandle, brokerageSyncService}` 반환. 조건부 등록·`lifecycle.register`·로깅 **그대로** 보존.
- **C. runtime/pipeline/automation composition** — `composition/runtime.ts`: `buildExecution(deps)` (tracer/runnerFactory/adapter 561-591), `buildPipeline(deps)` (593-653), `buildAutomation(deps)` (scheduler/newsMemorizer 704-757). 반환 번들. main() 은 이들 호출 + gateway/router/start 만 오케스트레이션.

> 밀스톤 경계는 todo-architect 가 의존 그래프로 재확인 후 미세조정 가능. **단, gateway 생성(759-816)·start(875-880)·deliveryHook lateinit(863-873)·MessageRouter(655-668) 은 main() 에 잔존** (상호결합·순서 민감 최상). 이번 phase 는 main() 을 898→~450 수준으로 감량하는 게 목표지 0 으로 만드는 게 아님.

## 의도적 비대상

- **패키지 추출(옵션 B/C)** — 후속 phase37 후보, 감독 필요.
- **기능·동작·API·로그 메시지 변경 일체** — 순수 구조. 동작 불변이 성공 기준.
- **wiring 순서/side-effect 재배치** — 절대 금지. storage.initialize → discord login → tool 등록 → gateway.start → scheduler.start 등 상대 순서 보존.
- **gateway/start/deliveryHook/MessageRouter 추출** — 결합도 최상이라 main() 잔존.
- main() 외 파일(execution-adapter, gateway 등)의 내부 리팩토링.

## 완료 조건

- [ ] `main()` LOC 가 유의미하게 감소 (목표 898 → ~450), 추출 블록이 `src/composition/*.ts` 로 이동.
- [ ] 추출 빌더 호출이 원래와 **같은 순서·같은 인자·같은 반환 객체**. 모든 `lifecycle.register` 가 동일 시점에 등록됨.
- [ ] `pnpm typecheck` + `pnpm build` + `pnpm test --run` (1681) + `pnpm test:storage` (151) + `pnpm lint` 전부 green.
- [ ] `main.test.ts` 가 green 유지 (부팅 경로 회귀 없음).
- [ ] git diff 가 **순수 이동**임을 리뷰에서 확인 (로직 변경 줄 0 — 추출/인자화 외 변경 없음).

## 추정

밀스톤 A(0.5일) + B(1일) + C(1-1.5일) = 2.5-3일. 순수 추출이라 위험은 "누락된 의존/순서 어긋남" 에 집중 — typecheck+build+test 가 잡음.

## 전제 / 리스크

- phase35 머지 후(#70) 진입. base = 현재 main HEAD.
- **최대 리스크**: 실 부팅 e2e 부재 → "동작 불변" 의 마지막 1% 는 키 보유자(사용자)의 수동 `pnpm dev` 부팅 smoke 로만 확정됨. review 에 명시 + 머지 후 권장.
- **부분 머지 허용**: 밀스톤 C 가 결합도로 위험하면 A(+B)만 머지하고 C 는 분리. phase35 와 동일 fallback 패턴.
- mock-only 스탠스 유지 — 신규 테스트 불요(순수 이동이라 기존 테스트가 회귀 안전망).
