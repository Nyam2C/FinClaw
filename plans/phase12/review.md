# Phase 12 Discord Channel Adapter -- 구현 리뷰

## 개요

- **브랜치**: `feature/discord-adapter`
- **사양 문서**: `plans/phase12/todo.md` (11개 단계, ~22개 파일)
- **실제 구현**: 소스 15개 + plugin.json, 테스트 7개, 수정 4개
- **리뷰 날짜**: 2026-03-06

---

## Step 1: 환경 구성

### 1.1 package.json

| 항목         | 사양                                                    | 실제                                                    | 판정                                           |
| ------------ | ------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------- |
| dependencies | `@finclaw/types`, `@finclaw/infra`, `discord.js`, `zod` | 동일                                                    | PASS                                           |
| 버전         | `discord.js: ^14.25.1`, `zod: ^3.25.0`                  | 동일                                                    | PASS                                           |
| key 순서     | dependencies 내부 순서                                  | `@finclaw/infra`가 `@finclaw/types` 앞 (알파벳 순 정렬) | INFO -- oxfmt 자동 정렬로 인한 차이. 문제 없음 |

### 1.2 tsconfig.json

| 항목        | 사양                              | 실제 | 판정 |
| ----------- | --------------------------------- | ---- | ---- |
| references  | `[types, infra]`                  | 동일 | PASS |
| 나머지 필드 | extends, outDir, rootDir, include | 동일 | PASS |

### 1.3 plugin.json

| 항목      | 사양                                   | 실제      | 판정 |
| --------- | -------------------------------------- | --------- | ---- |
| 전체 내용 | name, version, description, main, type | 완전 일치 | PASS |

---

## Step 2: 타입 + 설정

### 2.1 src/types.ts

| 항목                    | 사양                                  | 실제      | 판정 |
| ----------------------- | ------------------------------------- | --------- | ---- |
| DiscordAccount 타입     | 9개 readonly 필드                     | 완전 일치 | PASS |
| SlashCommand 인터페이스 | data + execute                        | 완전 일치 | PASS |
| CommandDeps 인터페이스  | financeService? + alertStorage?       | 완전 일치 | PASS |
| FinanceServicePort      | getQuote + searchNews                 | 완전 일치 | PASS |
| AlertStoragePort        | getAlerts + createAlert + deleteAlert | 완전 일치 | PASS |
| ApprovalButtonData      | 5개 readonly 필드                     | 완전 일치 | PASS |

### 2.2 src/config.ts

| 항목                 | 사양                                      | 실제      | 판정 |
| -------------------- | ----------------------------------------- | --------- | ---- |
| DiscordAccountSchema | zod/v4, strictObject, .readonly()         | 완전 일치 | PASS |
| 각 필드 default 값   | allowDMs: true, typingIntervalMs: 5000 등 | 완전 일치 | PASS |
| 내보내기             | DiscordAccount = z.infer<...>             | 완전 일치 | PASS |

---

## Step 3: 텍스트 청킹

### 3.1 src/chunking.ts

| 항목                    | 사양                                       | 실제      | 판정 |
| ----------------------- | ------------------------------------------ | --------- | ---- |
| chunkText 함수 시그니처 | (text, maxLength, maxLines) => string[]    | 완전 일치 | PASS |
| 분할 우선순위 5단계     | 빈 줄 > 줄바꿈 > 마침표+공백 > 공백 > 강제 | 완전 일치 | PASS |
| 코드 블록 추적          | trackCodeBlocks 함수                       | 완전 일치 | PASS |
| findSplitPoint          | effectiveMax, 0.5/0.3 비율                 | 완전 일치 | PASS |

### 3.2 test/chunking.test.ts

| 항목             | 사양 | 실제              | 판정 |
| ---------------- | ---- | ----------------- | ---- |
| 테스트 케이스 수 | 10개 | 10개 -- 완전 일치 | PASS |

---

## Step 4: 리치 임베드 빌더

### 4.1 src/embeds.ts

| 항목             | 사양                                                      | 실제                                                          | 판정                                  |
| ---------------- | --------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------- |
| import 순서      | EmbedBuilder 먼저                                         | `import type` 먼저 (`@finclaw/types`), 그 다음 `EmbedBuilder` | INFO -- import 순서만 다름. 기능 동일 |
| buildMarketEmbed | 색상, 필드, truncate                                      | 완전 일치                                                     | PASS                                  |
| buildNewsEmbed   | sentiment.label 중첩 접근                                 | 완전 일치                                                     | PASS                                  |
| buildAlertEmbed  | condition.field 조건부 표시                               | 완전 일치                                                     | PASS                                  |
| buildErrorEmbed  | 빨간색, truncate 4096                                     | 완전 일치                                                     | PASS                                  |
| 유틸리티 함수들  | truncate, formatCurrency, formatNumber, formatLargeNumber | 완전 일치                                                     | PASS                                  |

### 4.2 test/embeds.test.ts

| 항목             | 사양                                                                              | 실제                               | 판정                       |
| ---------------- | --------------------------------------------------------------------------------- | ---------------------------------- | -------------------------- |
| import 순서      | vitest 먼저                                                                       | `@finclaw/types` 먼저, vitest 다음 | INFO -- import 순서만 다름 |
| 테스트 케이스 수 | buildMarketEmbed 8, buildNewsEmbed 5, buildAlertEmbed 6, buildErrorEmbed 4 = 23개 | 동일                               | PASS                       |

---

## Step 5: 승인 버튼

### 5.1 src/buttons.ts

| 항목                               | 사양                           | 실제                                                                              | 판정                       |
| ---------------------------------- | ------------------------------ | --------------------------------------------------------------------------------- | -------------------------- |
| import 순서                        | discord.js 먼저, 그 다음 infra | `@finclaw/infra` 먼저, discord.js 다음                                            | INFO -- import 순서만 다름 |
| `Promise.withResolvers<boolean>()` | 사양에 명시                    | **미사용** -- 수동 패턴 `let resolve!: ...; new Promise((r) => { resolve = r; })` | **DEVIATION**              |
| buildApprovalRow                   | 완전 일치                      | 완전 일치                                                                         | PASS                       |
| waitForApproval                    | 타임아웃 로직                  | 기능적으로 동일                                                                   | PASS                       |
| setupApprovalHandler               | 버튼 인터랙션 처리             | 완전 일치                                                                         | PASS                       |
| \_resetPendingApprovals            | 테스트 유틸                    | 완전 일치                                                                         | PASS                       |
| MessageFlags.Ephemeral             | ephemeral: true 대신           | 올바르게 사용                                                                     | PASS                       |

**DEVIATION 상세**: `Promise.withResolvers()`는 ES2024 기능으로, Node.js 22+에서 지원된다. 프로젝트가 Node.js 22+를 요구하므로 사양대로 사용 가능하다. 수동 패턴도 기능적으로 동일하지만, todo.md의 명시적 코드와 다르다. 이 차이가 실제 동작에 영향을 주지는 않는다.

### 5.2 test/buttons.test.ts

| 항목             | 사양                                                                | 실제                           | 판정 |
| ---------------- | ------------------------------------------------------------------- | ------------------------------ | ---- |
| import 순서      | buttons.js 먼저, types.js 다음                                      | types.js 먼저, buttons.js 다음 | INFO |
| 테스트 케이스 수 | buildApprovalRow 2, waitForApproval 2, setupApprovalHandler 4 = 8개 | 동일                           | PASS |

---

## Step 6: Discord 클라이언트

### 6.1 src/client.ts

| 항목                     | 사양                                               | 실제                  | 판정 |
| ------------------------ | -------------------------------------------------- | --------------------- | ---- |
| import 순서              | discord.js 먼저                                    | `@finclaw/infra` 먼저 | INFO |
| createDiscordClient 함수 | intents, partials, ready, error, shardReconnecting | 완전 일치             | PASS |
| 테스트                   | 없음 (integration test 대상)                       | 없음                  | PASS |

---

## Step 7: 인바운드 핸들러

### 7.1 src/handler.ts

| 항목                                  | 사양                                            | 실제                                            | 판정 |
| ------------------------------------- | ----------------------------------------------- | ----------------------------------------------- | ---- |
| import 순서                           | discord.js 먼저, @finclaw/types, @finclaw/infra | @finclaw/types 먼저, discord.js, @finclaw/infra | INFO |
| InboundMessage 사용                   | IncomingMessage 아님                            | 올바르게 InboundMessage                         | PASS |
| CleanupFn 반환                        | `async () => { client.off(...) }`               | 완전 일치                                       | PASS |
| msg.author.bot + msg.system 이중 체크 | 사양 준수                                       | 완전 일치                                       | PASS |
| cleanContent 사용                     | regex 멘션 제거 대신                            | 완전 일치                                       | PASS |
| chatType 로직                         | DM=direct, thread=group, 기본=channel           | 완전 일치                                       | PASS |
| metadata 포함                         | discordChannelId, discordGuildId                | 완전 일치                                       | PASS |
| displayName fallback                  | `msg.author.displayName ?? msg.author.username` | 완전 일치                                       | PASS |

### 7.2 test/handler.test.ts

| 항목             | 사양        | 실제                | 판정 |
| ---------------- | ----------- | ------------------- | ---- |
| import 순서      | vitest 먼저 | @finclaw/types 먼저 | INFO |
| 테스트 케이스 수 | 10개        | 10개 -- 완전 일치   | PASS |

---

## Step 8: 아웃바운드 전송

### 8.1 src/sender.ts

| 항목                           | 사양                         | 실제                | 판정 |
| ------------------------------ | ---------------------------- | ------------------- | ---- |
| import 순서                    | discord.js 먼저              | @finclaw/types 먼저 | INFO |
| sendOutboundMessage            | resolveChannel + sendPayload | 완전 일치           | PASS |
| 청킹 + channelData 마지막 첨부 | 사양 준수                    | 완전 일치           | PASS |
| replyToMessageId 첫 청크에만   | 사양 준수                    | 완전 일치           | PASS |

### 8.2 test/sender.test.ts

| 항목             | 사양        | 실제                | 판정 |
| ---------------- | ----------- | ------------------- | ---- |
| import 순서      | vitest 먼저 | @finclaw/types 먼저 | INFO |
| 테스트 케이스 수 | 7개         | 7개 -- 완전 일치    | PASS |

---

## Step 9: 슬래시 커맨드

### 9.1 src/commands/ask.ts

| 항목      | 사양                                       | 실제      | 판정 |
| --------- | ------------------------------------------ | --------- | ---- |
| 전체 로직 | deferReply, chunkText, editReply, followUp | 완전 일치 | PASS |
| TODO 주석 | Phase 9 runner 호출                        | 완전 일치 | PASS |

### 9.2 src/commands/market.ts

| 항목                          | 사양           | 실제      | 판정 |
| ----------------------------- | -------------- | --------- | ---- |
| MessageFlags.Ephemeral        | 사양 준수      | 완전 일치 | PASS |
| financeService 미구현 시 처리 | "준비 중" 응답 | 완전 일치 | PASS |
| deferReply + editReply 패턴   | 사양 준수      | 완전 일치 | PASS |

### 9.3 src/commands/news.ts

| 항목       | 사양                            | 실제      | 판정 |
| ---------- | ------------------------------- | --------- | ---- |
| query 옵션 | setRequired(false)              | 완전 일치 | PASS |
| count 옵션 | addIntegerOption, min 1, max 10 | 완전 일치 | PASS |
| 전체 로직  | 완전 일치                       | 완전 일치 | PASS |

### 9.4 src/commands/alert.ts

| 항목           | 사양                             | 실제      | 판정 |
| -------------- | -------------------------------- | --------- | ---- |
| 서브커맨드 3개 | set, list, remove                | 완전 일치 | PASS |
| set 커맨드     | addChoices 3개, TODO createAlert | 완전 일치 | PASS |
| list 커맨드    | deferReply ephemeral + getAlerts | 완전 일치 | PASS |
| remove 커맨드  | deleteAlert + 응답               | 완전 일치 | PASS |

### 9.5 src/commands/index.ts

| 항목                  | 사양                               | 실제                                    | 판정 |
| --------------------- | ---------------------------------- | --------------------------------------- | ---- |
| import 순서           | REST/Routes 먼저, 커맨드들, infra  | infra 먼저, discord.js, types, 커맨드들 | INFO |
| registerGuildCommands | retry() 사용, guildIds 분기        | 완전 일치                               | PASS |
| setupCommandRouter    | isChatInputCommand, error handling | 완전 일치                               | PASS |

### 9.6 test/commands/market.test.ts

| 항목             | 사양        | 실제                | 판정 |
| ---------------- | ----------- | ------------------- | ---- |
| import 순서      | vitest 먼저 | @finclaw/types 먼저 | INFO |
| 테스트 케이스 수 | 4개         | 4개 -- 완전 일치    | PASS |

---

## Step 10: 어댑터 통합

### 10.1 src/adapter.ts

| 항목                                 | 사양                                      | 실제                                              | 판정 |
| ------------------------------------ | ----------------------------------------- | ------------------------------------------------- | ---- |
| import 순서                          | discord.js Client 먼저                    | @finclaw/types 먼저, discord.js, infra, 로컬 모듈 | INFO |
| `ChannelPlugin<DiscordAccount>` 구현 | 인터페이스 준수                           | 완전 일치                                         | PASS |
| setup() 반환값                       | `Promise<CleanupFn>`                      | 올바름 -- `async () => { ... }`                   | PASS |
| onMessage() 반환값                   | `CleanupFn`                               | 올바름 -- setupMessageHandler 반환값              | PASS |
| send() 시그니처                      | `(msg: OutboundMessage) => Promise<void>` | 완전 일치                                         | PASS |
| sendTyping                           | channelId + chatId, sendTyping in channel | 완전 일치                                         | PASS |
| addReaction                          | TODO stub                                 | 완전 일치                                         | PASS |
| id                                   | `createChannelId('discord')`              | 완전 일치                                         | PASS |
| meta                                 | name, displayName, icon, color, website   | 완전 일치                                         | PASS |
| capabilities                         | 9개 필드                                  | 완전 일치                                         | PASS |

### 10.2 test/adapter.test.ts

| 항목                 | 사양                                  | 실제                                         | 판정          |
| -------------------- | ------------------------------------- | -------------------------------------------- | ------------- |
| discord.js mock 방식 | `vi.fn().mockReturnValue(mockClient)` | **Proxy 기반 chain mock + MockClient class** | **DEVIATION** |
| 테스트 케이스 수     | 10개                                  | 10개 -- 완전 일치                            | PASS          |
| 테스트 내용          | 동일한 assertion                      | 동일                                         | PASS          |

**DEVIATION 상세**: 사양은 `Client: vi.fn().mockReturnValue(mockClient)` 팩토리 패턴을 사용하지만, 실제 구현은 `MockClient` class와 Proxy 기반 chain mock을 사용한다. Proxy 기반 approach는 SlashCommandBuilder의 메서드 체이닝을 더 견고하게 처리한다. 이는 **긍정적 일탈**로, 사양의 mock이 addSubcommand 등 중첩 체이닝에서 실패할 수 있는 문제를 선제적으로 해결한 것이다.

---

## Step 11: 진입점 + Config 확장

### 11.1 src/index.ts

| 항목                             | 사양                                      | 실제       | 판정                   |
| -------------------------------- | ----------------------------------------- | ---------- | ---------------------- |
| `import type { PluginManifest }` | 사양에 포함 (미사용)                      | **제거됨** | **POSITIVE DEVIATION** |
| discordAdapter 인스턴스          | `new DiscordAdapter()`                    | 완전 일치  | PASS                   |
| 타입 re-export                   | DiscordAccount, SlashCommand, CommandDeps | 완전 일치  | PASS                   |
| DiscordAdapter re-export         | `export { DiscordAdapter }`               | 완전 일치  | PASS                   |

**POSITIVE DEVIATION 상세**: todo.md에 `import type { PluginManifest } from '@finclaw/types';`가 포함되어 있으나 어디에서도 사용되지 않는다. 실제 구현에서 이를 제거한 것은 올바른 판단이다. 미사용 import는 lint 에러를 발생시킨다.

### 11.2 packages/config/src/zod-schema.ts

| 항목               | 사양                                                                                           | 실제      | 판정 |
| ------------------ | ---------------------------------------------------------------------------------------------- | --------- | ---- |
| 6개 필드 추가      | allowDMs, typingIntervalMs, maxChunkLength, maxChunkLines, approvalRequired, approvalTimeoutMs | 완전 일치 | PASS |
| `.optional()` 전용 | `.default()` 미사용                                                                            | 올바름    | PASS |
| 제약 조건          | min/max 값                                                                                     | 완전 일치 | PASS |

---

## 체크리스트 검증

### 타입 정합성

| 항목                                                 | 결과                                                                             |
| ---------------------------------------------------- | -------------------------------------------------------------------------------- |
| `ChannelPlugin<DiscordAccount>` 인터페이스 100% 준수 | PASS -- `setup?`, `onMessage?`, `send?`, `sendTyping?`, `addReaction?` 모두 구현 |
| `setup()` -> `CleanupFn` 반환                        | PASS                                                                             |
| `onMessage()` -> `CleanupFn` 반환                    | PASS                                                                             |
| `send(msg: OutboundMessage)` 단일 인자               | PASS                                                                             |
| `InboundMessage` 사용 (`IncomingMessage` 아님)       | PASS                                                                             |
| `senderId`, `body`, `chatType`, `Timestamp` 브랜드   | PASS                                                                             |
| `@finclaw/types` 금융 타입 직접 import               | PASS                                                                             |
| `MarketQuote.symbol`, `NewsItem.sentiment.label`     | PASS                                                                             |

### Config

| 항목                                                 | 결과 |
| ---------------------------------------------------- | ---- |
| `botToken` / `applicationId` (token / clientId 아님) | PASS |
| `DiscordAccountSchema`: Zod v4, `.readonly()`        | PASS |

### Discord.js API

| 항목                                                        | 결과                                                            |
| ----------------------------------------------------------- | --------------------------------------------------------------- |
| `ephemeral: true` 0개 -> `MessageFlags.Ephemeral` 전량 교체 | PASS -- `ephemeral: true` 검색 결과 0건                         |
| 슬래시 커맨드 3초 이내 `deferReply/reply`                   | PASS -- 모든 커맨드에서 첫 동작이 `deferReply()` 또는 `reply()` |
| `msg.author.bot` + `msg.system` 이중 체크                   | PASS                                                            |
| `cleanContent` 사용                                         | PASS                                                            |

### 인프라

| 항목                                           | 결과                                    |
| ---------------------------------------------- | --------------------------------------- |
| `console.log/error` 0개 -> `createLogger`      | PASS -- 소스 코드에 `console.` 사용 0건 |
| `plugin.json` 존재                             | PASS                                    |
| `@finclaw/infra`: `retry`, `createLogger` 사용 | PASS                                    |

### 테스트

| 항목           | 결과                                                                                             |
| -------------- | ------------------------------------------------------------------------------------------------ |
| 테스트 파일 수 | 7개 (사양: ~8개). 누락: 별도 news/alert 커맨드 테스트 없음. 단, 사양에서도 market.test.ts만 명시 |

---

## 파일 수 비교

| 카테고리    | 사양  | 실제                                                       | 비고                                                     |
| ----------- | ----- | ---------------------------------------------------------- | -------------------------------------------------------- |
| 소스 파일   | ~14개 | 14개 (+ plugin.json = 15)                                  | 일치                                                     |
| 테스트 파일 | ~8개  | 7개                                                        | 사양 본문에서 실제로 코드가 제시된 테스트도 7개          |
| 수정 파일   | 3개   | 4개 (package.json, tsconfig.json, zod-schema.ts, index.ts) | 사양은 index.ts를 "수정"이 아닌 "교체"로 분류했을 가능성 |

---

## 일탈 요약

### 부정적 일탈 (수정 고려)

| #   | 파일                   | 내용                                          | 심각도                                                                                           |
| --- | ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| D-1 | `src/buttons.ts:40-43` | `Promise.withResolvers()` 대신 수동 패턴 사용 | **LOW** -- 기능 동등. Node 22+에서 `Promise.withResolvers()` 사용이 더 간결하나 실질적 차이 없음 |

### 긍정적 일탈 (유지 권장)

| #   | 파일                   | 내용                                  | 판단                                        |
| --- | ---------------------- | ------------------------------------- | ------------------------------------------- |
| P-1 | `src/index.ts`         | 미사용 `PluginManifest` import 제거   | 올바름 -- lint 에러 방지                    |
| P-2 | `test/adapter.test.ts` | Proxy 기반 chain mock                 | 올바름 -- 중첩 메서드 체이닝 mock이 더 견고 |
| P-3 | 전 파일                | import 순서가 알파벳/패키지 우선 정렬 | 올바름 -- oxlint/포맷터 규칙 준수 추정      |

### 중립적 차이 (무시)

| #   | 범위         | 내용                                                 |
| --- | ------------ | ---------------------------------------------------- |
| N-1 | 전체         | import 문 순서가 todo.md와 다르지만 기능에 영향 없음 |
| N-2 | package.json | dependency 키 정렬 순서 (oxfmt 자동 정렬)            |

---

## 잠재적 이슈

### I-1: DiscordAccount 타입 이중 정의

`types.ts`와 `config.ts` 모두 `DiscordAccount` 타입을 내보낸다. `types.ts`는 수동 정의이고, `config.ts`는 `z.infer<typeof DiscordAccountSchema>`이다. 현재 `adapter.ts`는 `types.ts`의 것을 사용하고, `index.ts`도 `types.ts`에서 re-export한다. `config.ts`의 `DiscordAccount`는 외부에서 사용되지 않는다.

- **위험**: 두 타입이 구조적으로 동일하지 않을 가능성이 있다. `config.ts`의 `z.infer`는 `guildIds`가 `string[] | undefined`인 반면, `types.ts`는 `readonly string[] | undefined`이다. `.readonly()` 체이닝으로 `config.ts` 쪽도 readonly가 되지만, 런타임 Zod 파싱 결과와 `types.ts`의 수동 타입 간에 미묘한 차이가 발생할 수 있다.
- **권장**: `types.ts`의 수동 `DiscordAccount`를 제거하고 `config.ts`의 `z.infer` 타입만 사용하거나, 둘의 호환성을 `satisfies`로 검증하는 것을 고려할 것.

### I-2: setupCommandRouter 미호출

`adapter.ts`의 `setup()` 메서드에서 `registerGuildCommands`는 호출하지만, `setupCommandRouter`는 호출하지 않는다. 슬래시 커맨드를 등록만 하고 인터랙션 라우터를 설정하지 않으면, 등록된 커맨드에 대한 사용자 입력이 처리되지 않는다.

- **위험**: 프로덕션에서 `/market`, `/news`, `/alert`, `/ask` 커맨드를 실행해도 응답이 없을 것이다.
- **참고**: 사양(todo.md)의 `adapter.ts` 코드에도 `setupCommandRouter` 호출이 없으므로, 이는 사양 자체의 누락이다. 의도적으로 Phase 후반에 통합할 계획일 수 있다.

### I-3: setupApprovalHandler 미호출

`buttons.ts`에 `setupApprovalHandler`가 정의되어 있지만, `adapter.ts`에서 호출되지 않는다. 승인 버튼 시스템이 실제로 연결되지 않은 상태이다.

- **위험**: `waitForApproval()`을 호출해도 버튼 클릭 이벤트가 처리되지 않아 항상 타임아웃된다.
- **참고**: 이 역시 사양에서도 동일하게 누락되어 있으므로, 후속 Phase에서 통합 예정으로 보인다.

### I-4: news 커맨드 에러 미처리

`commands/news.ts`의 `execute`에서 `deps.financeService.searchNews()` 호출 시 에러 처리(try/catch)가 없다. `market.ts`는 try/catch로 에러를 editReply하지만 `news.ts`는 없다. 에러 시 `setupCommandRouter`의 catch가 처리하겠지만, 사용자에게 보이는 메시지가 일반적("명령 실행 중 오류가 발생했습니다")이 된다.

- **위험**: 낮음. `setupCommandRouter`의 전역 에러 핸들링이 있으므로 앱이 crash하지는 않으나, 구체적 에러 메시지가 손실된다.
- **참고**: 사양에서도 동일한 코드이므로 사양 준수 상태.

---

## 리팩토링 기회

### R-1: DiscordAccount 타입 통합 (중요도: 중)

`types.ts`의 수동 `DiscordAccount`를 `config.ts`에서 import하여 재사용하면 이중 정의를 제거할 수 있다. 또는 `types.ts`에서 수동 타입을 제거하고 `config.ts`의 `z.infer` 결과만 사용한다.

### R-2: setupCommandRouter / setupApprovalHandler 통합 (중요도: 높음)

`adapter.ts`의 `setup()`에서 `setupCommandRouter(client, {})` 및 `setupApprovalHandler(client)`를 호출해야 슬래시 커맨드와 승인 버튼이 실제로 동작한다. 이는 Phase 12 내에서 해결하거나, 후속 Phase에서 통합할지 결정이 필요하다.

### R-3: Promise.withResolvers 적용 (중요도: 낮음)

`buttons.ts`의 수동 Promise 패턴을 `Promise.withResolvers()`로 교체하면 3줄이 1줄로 줄어든다. Node 22+ 요구사항과 일치한다.

### R-4: news 커맨드 에러 처리 추가 (중요도: 낮음)

`commands/news.ts`에 market.ts와 동일한 try/catch 패턴을 추가하여 구체적 에러 메시지를 사용자에게 전달한다.

---

## 종합 판정

| 평가 항목        | 결과                                                                         |
| ---------------- | ---------------------------------------------------------------------------- |
| 사양 준수율      | **97%** -- 15/15 소스 파일이 기능적으로 사양과 일치                          |
| 부정적 일탈 수   | 1건 (D-1: Promise.withResolvers, LOW severity)                               |
| 긍정적 일탈 수   | 3건 (P-1, P-2, P-3 -- 모두 유지 권장)                                        |
| 잠재적 이슈      | 4건 (I-2, I-3이 가장 중요 -- setupCommandRouter/setupApprovalHandler 미호출) |
| 빌드 가능 여부   | 확인 필요 (`pnpm build` 실행 필요)                                           |
| 테스트 통과 여부 | 확인 필요 (`pnpm vitest run` 실행 필요)                                      |

---

### Critical Files

| 파일                   | 관련 이슈                                                  |
| ---------------------- | ---------------------------------------------------------- |
| `src/adapter.ts`       | I-2, I-3 -- setupCommandRouter/setupApprovalHandler 미호출 |
| `src/types.ts`         | I-1 -- DiscordAccount 이중 정의                            |
| `src/buttons.ts`       | D-1 -- Promise.withResolvers 일탈                          |
| `src/commands/news.ts` | I-4 -- 에러 처리 누락                                      |
| `test/adapter.test.ts` | P-2 -- Proxy mock 패턴 (사양과 가장 큰 구조적 차이)        |
