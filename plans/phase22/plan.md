# Phase 22 — 금융 파트너화 (Finance Partner Activation)

## Context

Phase 21에서 FinClaw의 수평 배선(Discord → Gateway → Pipeline → Runner → Tools → Storage)이 완성되어 Claude가 도구를 호출·저장하며 DM에 응답하는 상태까지 도달했다. 그러나 실제 **개인 금융 파트너**로서 기능하려면 네 가지가 빠져 있다.

1. **정체성 부재** — 시스템 프롬프트가 "You are FinClaw, a helpful personal assistant" 라는 범용 문구(`packages/server/src/main.ts:58-59`). 봇이 자기소개를 해도 "CNN/BBC 추천" 같은 일반 비서 멘트만 나옴.
2. **미배선 도구** — `packages/skills-finance/` 아래 **News 3개·Alerts 4개 도구가 이미 구현**되어 있으나 `main.ts`가 `registerMarketTools` 한 번만 호출하고 News/Alerts는 전혀 등록하지 않음. → 뉴스 조회·가격 알림 기능 자체가 비활성.
3. **감사·환각 방지 부재** — 도구 호출 input/output이 DB에 병렬 저장되지 않고, 응답에 출처·시각이 붙지 않음. 돈이 걸린 판단을 사후 추적할 근거가 부족.
4. **Phase 21 기술 부채** — `ctx.senderId`를 chatId로 오용하는 근본 버그(현재 `sender.ts` DM fallback으로 임시 우회), web 컨테이너 healthcheck 오작동, Phase 21-D(`!finclaw reset/status` 명령어) 미완.

본 Phase의 목표는 **이미 존재하는 부품들을 "금융 파트너" 정체성으로 묶어내고, 신뢰성의 최소 기준을 코드로 강제**하는 것이다. 신규 기능 개발보다 기존 자산의 활성화·정리가 주를 이룬다.

**사용자 결정 사항** (2026-04-22 Q&A):

- 풀 스코프 (A+B+C+D 4개 밀스톤 한 번에)
- 뉴스 프로바이더는 **Alpha Vantage News** 단일 — 주가 키 하나로 뉴스까지 커버
- 응답 출처 표기는 **DeliverStage 자동 자투리 부착** 방식 (Claude 판단에 맡기지 않고 코드로 강제)

---

## 밀스톤 A — 도메인 정체성 (Persona)

### 목표

봇이 자기소개·답변 태도·한계 표명 전부에서 "개인 금융 파트너"로 동작.

### 작업

**파일**: `packages/server/src/main.ts` (수정, ~40 LOC)

- `DEFAULT_SYSTEM_PROMPT` 상수(line 58-59) 재작성. 포함할 내용:
  - 역할: "너는 사용자의 **개인 금융 파트너**다. 투자 판단 보조·시장 분석·포트폴리오 추적이 주 업무."
  - 읽기 전용 원칙: "너는 조회·분석만 한다. 매매 실행·자금 이체는 절대 제안하지 않는다."
  - 환각 방지: "수치·뉴스는 반드시 도구로 확인. 모르면 '모른다' 말하라. 추측으로 가격·날짜를 지어내지 말라."
  - 출처 원칙: "수치 언급 시 어느 API·어느 시각 데이터인지 최대한 밝혀라."
  - 톤: "간결한 한국어. 불확실성은 숫자(신뢰도, 범위)로 표현."
- 상수로 추출해 Milestone B의 `registerAnalyzeMarketTool`용 Anthropic 클라이언트와 시스템 프롬프트가 일치하도록 구조 정리.

### 검증

- Discord DM에 "너 누구야" → 금융 파트너 자기소개 메시지 (범용 멘트 아님)
- "AAPL 지금 얼마야?" (도구 없는 상황에서) → "실시간 가격은 도구로만 확인 가능. 지금 API 키가 없어서 답할 수 없다" 류의 **정직한 한계 표명**

---

## 밀스톤 B — 금융 도구 3종 세트 배선

### 목표

이미 구현된 Market(4) + News(3) + Alerts(4) = **11개 도구가 실제로 Claude에 노출**되어 호출 가능한 상태.

### 전제

- `registerMarketTools`는 내부에서 `ProviderRegistry`·`MarketCache`·`AlertMarketService`를 생성함. 이들이 News(`quoteService`)·Alerts(`cache`, `registry`, `newsAggregator`) 배선에 필요.
- 현재 시그니처는 이들을 반환하지 않으므로 **소극적 리팩토링** 필요: `registerMarketTools`가 생성한 부품을 반환하도록 변경(혹은 생성은 main.ts로 올리고 register 함수는 등록만).

### 작업

**파일**:

- `packages/server/src/main.ts` (수정, ~120 LOC)
- `packages/skills-finance/src/market/index.ts` (수정, ~30 LOC — 반환 값 변경)
- `packages/skills-finance/src/index.ts` (수정, re-export 추가)
- `.env.example` (수정, NEWSAPI_KEY 선택 항목 설명 갱신)

**main.ts 배선 순서** (의존성 체인):

1. `registerMarketTools(...)` → `{ providerRegistry, marketCache, quoteService }` 반환
2. `registerNewsTools(registry, { db, alphaVantageKey, quoteService, anthropicApiKey })`
   - `createNewsAggregator`가 생성한 `newsAggregator`를 밖으로 노출
3. `registerAlertTools(registry, { db, cache: marketCache, registry: providerRegistry, newsAggregator, logger, discordClient })`
   - 반환된 `AlertMonitor` 수명주기를 `lifecycle.register`에 등록
4. 키 가용성별 그레이스풀 스킵:
   - Alpha Vantage 키 없으면 market + news 전부 스킵 (경고 로그)
   - CoinGecko 키 없으면 market에 crypto만 빠짐
   - Alerts는 market·news 둘 다 등록된 경우에만 시도 (newsAggregator 필수)

### 검증

- Discord DM "비트코인 오늘 가격" → `get_crypto_price` 도구 호출 → 실제 수치
- "애플 최신 뉴스 3개" → `get_financial_news` → Alpha Vantage News 응답
- "TSLA가 300달러 되면 알려줘" → `set_alert` 호출, DB `alerts` 테이블에 저장 확인
- "내 알림 목록" → `list_alerts` 조회
- `docker logs`에 `Market tools registered`, `News tools registered`, `Alert monitor started` 3개 로그 순서대로

---

## 밀스톤 C — 감사·출처 (Auditability)

### 목표

**"금융 파트너가 내 돈 얘기하는데 근거가 뭐냐"** 에 답할 수 있는 상태. 두 층위:

1. **사용자 가시 층**: 응답 끝에 도구 호출 출처·시각 자동 첨부
2. **DB 층**: tool 호출의 input/output/timestamp 영구 저장

### 작업

#### C1. DeliverStage 출처 자투리

**파일**: `packages/server/src/auto-reply/stages/deliver.ts` (수정, ~50 LOC)

- `ExecuteStageResult`에 실행된 도구 메타(`[{name, timestamp, source?}]`) 노출되는지 확인 후 필요시 `execution-adapter.ts` 확장
- `deliverResponse`에서 도구가 사용된 경우 마지막 chunk 끝에 footer 추가:
  ```
  ---
  📊 출처: get_stock_price(alpha-vantage) @ 2026-04-22 20:15 KST
  ```
- 도구 여러 개면 목록으로, 사용 안 했으면 footer 생략
- 2000자 제한 고려해 chunk split 로직 앞 단계에서 주입

#### C2. 도구 이력 상세 저장

**파일**:

- `packages/server/src/auto-reply/execution-adapter.ts` (수정, ~30 LOC)
- `packages/storage/src/tables/messages.ts` (수정, ~40 LOC)

- `messages.tool_calls` JSON 컬럼에 현재는 `name` 정도만 저장됨 → `{name, input, output, timestamp, durationMs, isError}` 구조로 확장
- 기존 컬럼을 그대로 쓰고 JSON 스키마만 확장 (DB 마이그레이션 불필요, 기존 NULL/빈 배열 그대로 유지)
- 읽기 헬퍼 `getToolCallHistory(conversationId)` 추가 (Milestone D의 `!finclaw status`·미래 감사 CLI 용)

### 검증

- Discord DM "애플 주가" → 응답 하단에 `📊 출처: get_stock_price(alpha-vantage) @ ...` 표시
- `docker exec finclaw-server node -e "..."` 로 `messages.tool_calls` JSON 확인 시 input/output이 실제로 들어 있음
- 응답 footer 포함 총 길이가 2000자 넘는 긴 답변도 깨지지 않고 chunking 유지

---

## 밀스톤 D — Phase 21 기술 부채 청산

### D1. chatId 근본 수정

**파일**:

- `packages/types/src/message.ts` (수정)
- `packages/server/src/process/message-router.ts` (수정)
- `packages/server/src/auto-reply/pipeline.ts` (수정, line 136 근처)
- `packages/server/src/auto-reply/stages/deliver.ts` (수정, line 48·59)
- `packages/channel-discord/src/sender.ts` (수정 — DM fallback 제거)
- `packages/channel-discord/src/adapter.ts` (수정 — sendTyping 이제 정상 channelId 받음)

**변경점**:

- `MsgContext`/`PipelineMsgContext`에 `chatId: string` 필드 추가 (Discord 채널 ID·DM 채널 ID 모두 여기로)
- `InboundMessage.metadata.discordChannelId` → `MsgContext.chatId` 복사 (router 단계)
- `pipeline.ts:136`와 `deliver.ts:48/59`가 `ctx.senderId` 대신 `ctx.chatId` 사용
- `sender.ts`의 10003 에러 DM fallback 제거 (더 이상 필요 없음)
- `adapter.ts`의 `sendTyping` try/catch는 유지(방어 차원), 하지만 정상 경로에서 에러 안 남

### D2. `!finclaw` 명령어 (Phase 21-D 미완)

**파일**:

- `packages/server/src/auto-reply/commands/` 아래 (수정·신규)
- `packages/server/src/main.ts` (수정 — registry에 명령어 등록)

**명령어**:

- `!finclaw status` — 봇 상태 요약 출력
  - 등록된 도구 개수, 현재 대화 세션 ID, 저장된 메시지 수, 최근 활성 알림 개수
  - `packages/storage` 헬퍼(`getToolCallHistory` 등)로 조회
- `!finclaw reset` — 현재 세션(sender별 conversation) 삭제 + 새 세션 시작 안내
- 명령어는 AutoReplyPipeline이 처리 전에 가로챔 (기존 `commandPrefix: '!finclaw '` 활용)

### D3. Web 컨테이너 healthcheck

**파일**: `docker-compose.yml` (수정, ~3 LOC)

- `web` 서비스에 `healthcheck: disable: true` 또는 자체 `GET /` 검사로 override
- 현재 server의 `/healthz`가 image-level healthcheck로 web에도 적용돼 항상 unhealthy로 표시되는 문제 해결

### 검증

- Discord DM에서 `!finclaw status` → 상태 메시지 응답
- `!finclaw reset` → 세션 초기화 확인 (기존 맥락 날아감)
- `docker logs finclaw-server 2>&1 | grep "sendTyping failed"` → **결과 없음** (이제 올바른 channel ID 받으니 실패 안 함)
- `docker compose ps` → `finclaw-web Up ... (healthy)` (unhealthy 표시 사라짐)
- 기존 1316 테스트 + D1 변경 인한 테스트 업데이트분 전부 통과

---

## 선행 조건 (Phase 21 산출물 사용처)

| 선행                                        | 위치                                          | 본 Phase 사용처          |
| ------------------------------------------- | --------------------------------------------- | ------------------------ |
| `registerMarketTools`                       | `packages/skills-finance/src/market/index.ts` | B에서 호출 + 반환값 확장 |
| `registerNewsTools` (구현 있음, 호출 없음)  | `packages/skills-finance/src/news/index.ts`   | B에서 첫 호출            |
| `registerAlertTools` (구현 있음, 호출 없음) | `packages/skills-finance/src/alerts/index.ts` | B에서 첫 호출            |
| `AutoReplyPipeline` commandPrefix           | `packages/server/src/auto-reply/pipeline.ts`  | D2에서 활용              |
| SQLite `alerts`, `messages.tool_calls` 컬럼 | `packages/storage/src/tables/`                | B·C에서 첫 사용          |
| `InboundMessage.metadata.discordChannelId`  | `packages/channel-discord/src/handler.ts:47`  | D1에서 MsgContext로 전파 |

---

## 제외 (본 Phase 범위 밖)

| 제외 항목                                  | 사유                                                          |
| ------------------------------------------ | ------------------------------------------------------------- |
| NewsAPI (newsapi.org) 프로바이더 추가 배선 | Alpha Vantage News 단일로 충분. RSS는 fallback으로 그대로 둠  |
| 매매 실행 도구 (buy/sell/transfer)         | **의도적·영구적 제외**. 읽기 전용 원칙                        |
| Portfolio CRUD UI (holdings 편집)          | `skills-finance`에 Portfolio\*Tool은 조회만 우선. 쓰기는 별도 |
| 차트 이미지 생성 (charts.ts)               | Discord embed에 텍스트만 — visual은 후속                      |
| MCP 프로토콜, 플러그인 런타임, Evals       | Phase 23+                                                     |
| 웹 UI 명령어 버튼                          | TUI·Discord만 — Web은 Phase 19 산출물 단순 preview 수준 유지  |
| 도구 호출 감사 리뷰 CLI                    | `getToolCallHistory` 헬퍼만 추가. 별도 CLI/UI는 후속          |

---

## 복잡도 및 예상 파일 수

| 항목                 | 값                                                     |
| -------------------- | ------------------------------------------------------ |
| 복잡도               | **M-L**                                                |
| 신규 파일            | 1~2 (`commands/status.ts`, `commands/reset.ts` 가능성) |
| 수정 파일            | 11~13                                                  |
| 예상 LOC (신규+수정) | ~600                                                   |
| 새 외부 의존성       | 없음                                                   |
| DB 마이그레이션      | 없음 (JSON 컬럼 스키마만 확장)                         |

### 밀스톤별 규모

| Milestone     | 규모               | 리스크                                              |
| ------------- | ------------------ | --------------------------------------------------- |
| A (Persona)   | ~40 LOC, 1 파일    | 저                                                  |
| B (도구 배선) | ~150 LOC, 3~4 파일 | 중 (외부 API 의존성 체인)                           |
| C (감사·출처) | ~120 LOC, 3 파일   | 중 (DeliverStage 기존 chunking과 충돌 주의)         |
| D (부채 청산) | ~290 LOC, 6~8 파일 | 중 (D1은 타입 변경 파급, 기존 테스트 업데이트 필요) |

---

## 마이그레이션 / 호환성

- **DB**: 스키마 변경 없음. `messages.tool_calls` JSON 내부 구조만 확장 — 기존 레코드(`null` 또는 `[]`)와 공존 가능.
- **API 키**: 신규 필수 키 없음. Alpha Vantage 키가 없으면 market+news 전부 그레이스풀 스킵(봇은 기동되지만 도구 미등록 로그 뜸).
- **Downgrade**: D1의 MsgContext 변경을 revert하면 pre-Phase 22 상태로 복귀. A/B/C는 기능 플래그나 system prompt 되돌리기로 역전 가능.
- **기존 테스트**: D1의 `pipeline.ts`·`deliver.ts` 시그니처 변경으로 일부 테스트 업데이트 필요(추정 ~10개). 나머지는 무영향.

---

## 크리티컬 파일 (수정 예정, 경로+라인)

| 파일                                                  | 밀스톤 | 변경 요지                                                                           |
| ----------------------------------------------------- | ------ | ----------------------------------------------------------------------------------- |
| `packages/server/src/main.ts` (L58-59, L96-120)       | A·B·D2 | 시스템 프롬프트 재작성, news/alerts 등록, 명령어 레지스트리 연결                    |
| `packages/skills-finance/src/market/index.ts`         | B      | `registerMarketTools` 반환값에 `{providerRegistry, marketCache, quoteService}` 포함 |
| `packages/skills-finance/src/index.ts`                | B      | `registerNewsTools`, `registerAlertTools`, `NewsAggregator` 등 re-export            |
| `packages/server/src/auto-reply/stages/deliver.ts`    | C1·D1  | 출처 footer 주입, `ctx.chatId` 사용                                                 |
| `packages/server/src/auto-reply/execution-adapter.ts` | C2     | ExecutionResult에 도구 호출 메타 포함                                               |
| `packages/storage/src/tables/messages.ts`             | C2     | tool_calls JSON 구조 확장 + `getToolCallHistory` 추가                               |
| `packages/types/src/message.ts`                       | D1     | `MsgContext`에 `chatId?: string` 필드 추가                                          |
| `packages/server/src/process/message-router.ts`       | D1     | `msg.metadata.discordChannelId` → `ctx.chatId` 복사                                 |
| `packages/server/src/auto-reply/pipeline.ts` (L136)   | D1     | `ctx.senderId` → `ctx.chatId`                                                       |
| `packages/channel-discord/src/sender.ts`              | D1     | 10003 DM fallback 로직 제거                                                         |
| `packages/channel-discord/src/adapter.ts`             | D1     | sendTyping 정상 경로 보장 (try/catch는 방어 차원 유지)                              |
| `packages/server/src/auto-reply/commands/*`           | D2     | `status`·`reset` 핸들러 신규                                                        |
| `docker-compose.yml`                                  | D3     | web 서비스 healthcheck override                                                     |
| `.env.example`                                        | B      | Alpha Vantage가 주가+뉴스 둘 다 커버함 주석 추가                                    |

---

## End-to-end 검증 시나리오

`pnpm install && pnpm build && pnpm typecheck && pnpm test` 통과 후, `.env`에 `ANTHROPIC_API_KEY`, `DISCORD_BOT_TOKEN`, `DISCORD_APPLICATION_ID`, `ALPHA_VANTAGE_KEY`가 설정된 상태에서:

```bash
pnpm run dev:all
```

Discord DM 시나리오:

1. **자기소개** — "너 뭐 할 수 있어?" → 금융 파트너 페르소나 + 도구 카탈로그 답변
2. **시세** — "지금 AAPL 주가" → `get_stock_price` 호출 → 응답 하단에 `📊 출처: get_stock_price(alpha-vantage) @ ...`
3. **뉴스** — "테슬라 최근 뉴스" → `get_financial_news` → 기사 목록 + 출처
4. **알림** — "AAPL 150달러 되면 알려줘" → `set_alert` 성공 메시지
5. **목록** — "내 알림" → `list_alerts` 조회 결과
6. **상태** — `!finclaw status` → 등록 도구·세션·메시지 카운트
7. **리셋** — `!finclaw reset` → 세션 초기화 확인
8. **환각 방지** — "다음 주 애플 주가 얼마야?" → "예측 불가" 류의 정직한 거절
9. **읽기 전용** — "내 돈으로 AAPL 10주 매수해줘" → "나는 매매 실행 권한 없음" 거절

서버 관찰:

- `docker logs finclaw-server | grep -E "tools registered|monitor started"` → market + news + alert 전부 로그
- `docker logs finclaw-server | grep "sendTyping failed"` → **빈 결과**
- `docker compose ps` → web도 `(healthy)`
- `docker exec finclaw-server node -e "..."`로 `messages.tool_calls`의 JSON이 `{name,input,output,timestamp,durationMs}` 구조인지 샘플 확인

---

## 리스크 및 완화

| 리스크                                              | 완화                                                                                |
| --------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Alpha Vantage 뉴스 응답 스키마가 Market 응답과 다름 | `news/providers/alpha-vantage-news.ts` 이미 구현됨(별도 provider). 재사용만 하면 됨 |
| Alerts의 `ProviderRegistry` 순환 참조 가능성        | main.ts 선형 초기화 순서로 회피 (market → news → alerts)                            |
| D1의 MsgContext 변경이 기존 테스트 다수 깨뜨림      | 전체 vitest 돌려 회귀 확인 후 시그니처 변경 범위 최소화                             |
| DeliverStage footer가 Discord 2000자 제한과 충돌    | chunk split 이전에 주입 + footer 크기 상한 설정                                     |
| `!finclaw reset`이 다른 사용자 세션까지 영향        | sender 단위로만 초기화 (conversation sender_id 일치 조건)                           |
