# Phase 38 — FinClaw Claude 전용 확정 (dead multi-provider 흔적 + dead config 제거)

> 사용자 결정(2026-05-26): FinClaw 를 Claude 전용으로 못박는다. non-Claude LLM 공급자를 상정한 **dead 스캐폴딩**(OpenAI chat 어댑터·카탈로그·ProviderId 'openai')과 **dead config**를 제거. 전부 동작 0 변화(미사용 검증 완료) — typecheck/build/test 가 안전망.

## 결정 (2026-05-26)

FinClaw 의 런타임 LLM 공급자는 이미 Claude 뿐(`ProviderKind = 'anthropic-sdk' | 'claude-cli'`, 둘 다 Claude). non-Claude 를 상정한 흔적은 **전부 dead**(아래 검증). Claude 전용을 코드로 확정하고 투기적 multi-provider 표면을 제거한다.

## ★ 중요 — ProviderId 좁히기 정확화

`ProviderId = 'anthropic' | 'openai' | 'claude-cli'`(`catalog.ts:4`)에서 **`'openai'`만 제거** → `'anthropic' | 'claude-cli'`. **`'claude-cli'` 는 유지**(CLI 어댑터가 `providerId='claude-cli'` 로 사용 — `claude-cli/adapter.ts:19`). 둘 다 Claude. 리터럴 `'anthropic'` 단일로 좁히면 CLI 어댑터가 깨지므로 금지.

## 범위 (코드 실측 검증, 2026-05-26)

### 제거 — 전부 dead, 동작 0 변화 (검증됨)

| 대상                                               | 위치                                                                                                                                                                                                        | dead 근거                                                                                              |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `OpenAIAdapter` (chat 어댑터)                      | `packages/agent/src/providers/openai.ts`                                                                                                                                                                    | `new OpenAIAdapter` 호출 0 (export만, factory 가 anthropic-sdk/claude-cli 만 생성)                     |
| 위 export                                          | `packages/agent/src/index.ts:71`                                                                                                                                                                            | 〃                                                                                                     |
| `openai` npm 의존성                                | `packages/agent/package.json:19`                                                                                                                                                                            | `from 'openai'` 가 위 dead 어댑터 1곳에서만 (openai-compat 은 프로토콜 자체구현, 임베딩도 미사용)      |
| OpenAIAdapter 테스트 케이스                        | `packages/agent/src/providers/structured-output.test.ts:65~`                                                                                                                                                | 어댑터 제거에 동반. **AnthropicAdapter 케이스(`:13,45`)는 유지**                                       |
| 카탈로그 `gpt-4o`/`gpt-4o-mini`                    | `packages/agent/src/models/catalog-data.ts:68-108`                                                                                                                                                          | `DEFAULT_FALLBACK_CHAIN`(Claude 3개)에 없음, 실행할 어댑터 없음                                        |
| `ProviderId` 의 `'openai'`                         | `packages/agent/src/models/catalog.ts:4`                                                                                                                                                                    | 위 제거 후 'openai' provider 모델 0                                                                    |
| `ENV_KEY_MAP` 의 openai 엔트리                     | `packages/agent/src/auth/resolver.ts:33`                                                                                                                                                                    | `Record<ProviderId>` 완전성용 — union 에서 빠지면 동반 제거                                            |
| `runner.ts` truncate "multi-provider 도입 시" 주석 | `packages/agent/src/execution/runner.ts:190-191`                                                                                                                                                            | Claude 전용 확정 → 투기 문구 제거 (하드코딩 400K 값은 Claude 200K 기준 유지)                           |
| dead finance config                                | `packages/types/src/config.ts` `FinanceConfig.{dataProviders,newsFeeds,alertDefaults}` + 하위 타입(`DataProviderConfig`/`NewsFeedConfig`/`AlertDefaultsConfig`) + `zod-schema.ts` `FinanceSchema` 해당 필드 | 감사 Lane4: 소비처 0 (`portfolios` 도 dead 여부 architect 확인 — dead 면 FinanceConfig 자체 정리 검토) |

### 절대 유지 (multi-provider 아님)

- **`gateway/openai-compat/*`** — inbound OpenAI 호환 API(`/v1/chat/completions`). OpenAI 클라가 FinClaw 에 말걸면 내부는 Claude. `openai` 패키지 미사용(프로토콜 자체구현). 실 기능.
- **OpenAI 임베딩** — `storage/embeddings/{provider.ts,openai.ts}` 의 `EmbeddingMode='openai'`. RAG 용(Anthropic 임베딩 API 부재). `ProviderId` 와 무관한 별도 타입. 유지.
- **dual-path provider** — `anthropic-sdk` / `claude-cli` (둘 다 Claude). 유지.
- **`provider-normalize.ts`·catalog machinery** — Claude(anthropic|claude-cli) 처리에 여전히 필요. 좁힌 ProviderId 로 유지.

## 밀스톤 (각 = 1 커밋, 동작 불변, typecheck/build/test 안전망)

- **A. dead OpenAI LLM 공급자 표면 제거** — `providers/openai.ts` 삭제 + `index.ts:71` export 제거 + `agent/package.json` 에서 `openai` 제거(+`pnpm install` 로 lockfile 갱신) + `structured-output.test.ts` 의 OpenAIAdapter 케이스 제거(Anthropic 유지) + 카탈로그 gpt-4o/mini 제거 + `ProviderId` 에서 `'openai'` 제거 + `ENV_KEY_MAP`/`health.test.ts:97` 정합. typecheck 가 누락 ripple 포착.
- **B. de-speculate + dead config** — `runner.ts:190` 주석 Claude 전용으로 + dead finance config(`dataProviders`/`newsFeeds`/`alertDefaults` + 하위 타입 + zod 필드) 제거.

각 밀스톤 끝: `pnpm typecheck` + `pnpm build` + `pnpm test --run` + `pnpm test:storage` + `pnpm lint`. (A 는 `pnpm install` 후 lockfile 변경 포함.)

## 의도적 비대상

- **`gateway/openai-compat/*` / OpenAI 임베딩 / dual-path** — 유지(위).
- **catalog machinery 자체 제거** — `getModelsByProvider`·`provider` 필드·`provider-normalize` 는 Claude 처리에 필요, 좁힌 ProviderId 로 유지(§2 — 과도한 제거 금지).
- **다른 P2 dead code**(execution:_/agent:run:_ 이벤트·always-NULL 컬럼·DefaultPipelineObserver·README 39→45) — 별도 정리, 본 phase 비대상.
- **P0-2/agent.list/tier 발산** — 별도.

## 완료 조건

- [ ] `providers/openai.ts` + `openai` 의존성 제거, `grep -rn "from 'openai'"` 가 0 (임베딩/openai-compat 무영향).
- [ ] `ProviderId` = `'anthropic' | 'claude-cli'`, 'openai' 참조 0(임베딩 `EmbeddingMode` 제외). CLI 어댑터 `providerId='claude-cli'` 정상.
- [ ] 카탈로그에 non-Claude 모델 0, `DEFAULT_FALLBACK_CHAIN` 불변.
- [ ] dead finance config(dataProviders/newsFeeds/alertDefaults) 제거, `validateConfigStrict` 정상.
- [ ] `pnpm typecheck` + `pnpm build` + `pnpm test --run` + `pnpm test:storage` + `pnpm lint` green. test 수는 OpenAIAdapter 케이스 제거분만큼 감소(정당), 그 외 불변.

## 추정

A(1일, ProviderId ripple + dep 제거) + B(0.5일) = 1.5일. typecheck 가 ripple 안전망.

## 전제 / 리스크

- phase37 머지 후(#72) 진입. base = 현재 main HEAD.
- **유일 실질 리스크**: ProviderId 좁히기가 `Record<ProviderId>`(ENV_KEY_MAP) 완전성·`'openai'` 리터럴 할당처를 건드림 → **typecheck 가 전수 포착**(컴파일 안 되면 누락). build+test 가 2차 안전망.
- `openai` 의존성 제거 후 `pnpm install` 로 lockfile 갱신 필요(커밋 포함).
- mock-only 유지. 동작 불변(dead 제거)이라 신규 테스트 불요, 기존이 회귀망.
