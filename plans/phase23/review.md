# Phase 23 구현 리뷰

## 개요

Phase 23 은 `plan.md` 3밀스톤 / `todo.md` 12 Todo 로 구성됐다. 목표는 **AI 를 거치지 않는 프로그래밍 접근 경로 배선** — 기존 skills-finance 서비스를 JSON-RPC·Web UI 로 노출하는 작업. 신규 기능 개발은 0.

브랜치 `feature/model-routing-rpc` (base: `feature/finance-partner`) 에서 **3 커밋 추가**. 작업 트리 clean.

---

## Todo별 구현 일치도

| Todo | 항목                                                       | 상태 | 커밋         | 비고                                       |
| ---- | ---------------------------------------------------------- | ---- | ------------ | ------------------------------------------ |
| 1    | skills-finance handle 확장 (alertStore/portfolioStore)     | OK   | `25c1402`    | AlertSkillHandle 신설                      |
| 2    | `finance.ts` 5개 메서드 실구현                             | OK   | `25c1402`    | closure-based deps 주입                    |
| 3    | `main.ts` RPC 등록 + `monitor.evaluateOnce` 추가           | OK   | `25c1402`    | GatewayServerDeps.financeDeps 옵셔널       |
| 4    | `finance.test.ts` 재작성 (19 케이스)                       | OK   | `25c1402`    | dispatchRpc 통합 테스트                    |
| 5    | `agent.ts` 3개 메서드 실구현                               | OK   | `1783811`    | ConcurrencyLane(1) 큐잉 + 타임아웃         |
| 6    | `main.ts` agent RPC 등록                                   | OK   | `1783811`    | GatewayServerDeps.agentDeps 옵셔널         |
| 7    | `agent.test.ts` 신규 (10 케이스)                           | OK   | `1783811`    | 동시 2요청 큐잉 verify 포함                |
| 8    | `app-gateway` 래퍼 (createFinanceClient/createAgentClient) | OK   | `88ab701`    | 타입드 클라이언트 + FinanceQuote 등 export |
| 9    | `market-view` 배선                                         | OK   | `88ab701`    | 입력 폼 + 최근 5개 카드 + 상승/하락 색상   |
| 10   | `portfolio-view` 배선                                      | OK   | `88ab701`    | 자동 로드 + 빈 상태 + 새로고침             |
| 11   | `alerts-view` 배선                                         | OK   | `88ab701`    | 4개 condition 폼 + immediateTrigger 메시지 |
| 12   | 최종 검증 + 커밋                                           | OK   | (상기 3커밋) | build/typecheck/lint/test 전부 통과        |

---

## 계획 외 추가 변경

| 항목                                                                     | 이유                                                 |
| ------------------------------------------------------------------------ | ---------------------------------------------------- |
| `collectToolCalls` export 승격                                           | agent.run 응답 구성에서 재사용 필요 — 코드 중복 회피 |
| `AlertCondition` / `CreateAlertInput` / `AlertDefinition` 타입 re-export | finance.ts 가 condition 변환에 필요                  |
| `PortfolioStore` value export (class)                                    | finance RPC 타입 참조용                              |
| `resetAgentStats()` export                                               | agent.test 에서 프로세스 내 카운터 초기화            |
| 빌드 에러 수정: `app-gateway.ts` 의 `isConnected` 중복                   | 원본에 getter 이미 있었음. 작성 시 추가한 구현 제거  |

---

## 계획 vs 실제 API 차이 (todo.md 가정 보정)

todo.md 작성 시 실제 코드를 완전히 확인 못 했고, 구현 중 아래 차이를 발견해 어댑트했다. review 후 phase24 계획 갱신 필요 시 참고.

| 영역                                      | 계획(todo.md) 가정                                             | 실제 코드                                                                                          | 대응                                                                                                                                |
| ----------------------------------------- | -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `QuoteService`                            | `getStockPrice/getCryptoPrice/getForexRate` 3개 메서드         | `getQuote(symbol)` 하나만. stock/crypto/forex 판별은 내부 ProviderRegistry                         | RPC 파라미터에서 `kind` 제거, 단일 호출로 통합                                                                                      |
| `AlertStore.create`                       | `async` + Promise                                              | **동기** 반환                                                                                      | `await` 제거, 동기 호출                                                                                                             |
| `AlertStore.list({symbol})`               | 심볼 필터 지원                                                 | `listByUser(userId)` 만. 심볼 필터 없음                                                            | RPC 레이어에서 client-side filter                                                                                                   |
| `CreateAlertInput`                        | `{symbol, condition: 'price_above', threshold}` 평평한 구조    | `{userId, name, condition: AlertCondition, channels, ...}` — condition 이 discriminated union 객체 | RPC 파라미터를 `AlertCondition` 객체로 변환하는 helper 추가                                                                         |
| `PortfolioStore.list()` / `getHoldings()` | 가정한 메서드명                                                | 실제는 `listPortfolios()`. holdings 는 Portfolio 객체 내부 필드                                    | 메서드명 교체                                                                                                                       |
| `AlertMonitor.evaluateOnce`               | 이미 존재한다고 가정                                           | 존재하지 않음                                                                                      | **monitor.ts 에 메서드 신설** (Todo 3 범위)                                                                                         |
| 에러 코드                                 | `-32010 provider_unavailable` / `-32011 invalid_symbol` 커스텀 | 현재 RPC dispatch 는 catch 후 `-32603 INTERNAL_ERROR` 만 생성                                      | 커스텀 코드 도입 대신 **에러 메시지 prefix** (`provider_unavailable: ...`) 로 단순화. Phase 24+ 에서 RPC 에러 시스템 확장 시 정식화 |

---

## 상세 리뷰

### 밀스톤 A — `finance.*` RPC 배선

- **closure-based deps 주입**: RPC 등록 함수를 `registerFinanceMethods(deps)` 로 변경. 모듈 로드 시점이 아닌 main.ts 의 skills 초기화 후에 호출. handler 는 deps 를 closure 로 캡처해 런타임 주입. **RPC 레지스트리 구조 변경 없이** DI 달성.
- **graceful skip**: API 키 미설정 시 deps 필드가 `undefined` → 해당 메서드 호출 시 `provider_unavailable` 에러. 서버 자체는 기동 가능.
- **즉시 평가(Alert)**: `monitor.evaluateOnce(alertId)` 는 쿨다운/lane 우회로 설계. 정기 모니터 주기(30초)와 **별개 경로**라 RPC 응답이 빠름. 평가 실패 시 알림 저장은 유지 + `immediateTrigger: false` + 경고 로그.
- **타입 export 확대**: skills-finance/src/index.ts 에서 `AlertCondition`, `CreateAlertInput`, `AlertDefinition`, `PortfolioStore` 를 공개. 이전엔 내부 타입이었음. Phase 25 의 transactions 기능에서도 재사용 예정.

### 밀스톤 B — `agent.*` RPC 배선

- **에이전트 레지스트리 부재 → 하드코딩 1개**: `finclaw-partner` 단일 에이전트. Phase 24 의 역할 라우팅에서 확장 시 자연스럽게 다수화 가능한 구조.
- **큐잉**: `ConcurrencyLaneManager` 의 내장 레인(main/cron/subagent) 이 고정이라 **별도 `ConcurrencyLane` 인스턴스** 를 main.ts 에서 생성(`maxConcurrent: 1, maxQueueSize: 10, waitTimeoutMs: 120s`). agent.ts 에 deps 로 주입. Runner 내부의 lane 과는 독립된 RPC 레벨 게이트.
- **타임아웃**: `AbortController` + `setTimeout` 조합. 기본 60s, 최대 120s.
- **감사 = 로그 파일 only**: `logger.info('agent.run.started/completed')` / `logger.warn('agent.run.failed')` 3지점. DB 저장 + RAG 는 Phase 25.
- **collectToolCalls 재사용**: execution-adapter 의 private 함수를 export 로 승격. 채팅 경로와 agent.run 이 동일한 감사 레코드 포맷 공유.

### 밀스톤 C — Web UI 3뷰

- **gateway property 주입 패턴**: app.ts 가 `.gateway=${this.gateway}` 로 각 뷰에 Lit property 주입. 기존 chat 경로와 일관.
- **createFinanceClient/createAgentClient**: 얇은 래퍼. `gateway.send(method, params) as Promise<T>` 형태로 타입만 붙임. Phase 24 에서 `modelHint` 파라미터 추가 시 여기만 건드리면 됨.
- **3뷰 공통 패턴**: `gateway.isConnected` 상태 체크 → 비연결 시 "대기 중" UI. 이미 Lit reactive property 라 재렌더링 자연스러움.
- **Alerts 뷰 제약**: 삭제(remove) UI 없음. `finance.alert.remove` RPC 가 Phase 23 범위 밖 — 채팅에서 요청하도록 안내 문구.
- **Settings 뷰**: 손대지 않음. `config.*` RPC stub 상태라 배선 대상 아님.

---

## 범위 외 (의식적으로 남긴 것)

| 항목                                            | 왜                                 | 다음 Phase                         |
| ----------------------------------------------- | ---------------------------------- | ---------------------------------- |
| `config.*` RPC 실구현                           | stub 유지, Settings 뷰와 함께 이관 | Phase 24+                          |
| `finance.alert.remove` / `portfolio.update` RPC | Web 삭제 UX 필요 시 추가           | Phase 24+                          |
| OpenAI 호환 `/v1/chat/completions`              | 별도 의제 (서드파티 SDK 호환)      | Phase 26+                          |
| TUI 패널 (market/portfolio/alerts)              | Web 과 중복, 우선순위 낮음         | Phase 26+                          |
| Discord `/ask` 슬래시 커맨드                    | `!finclaw` 메시지로 대체 가능      | Phase 24+                          |
| `StubFinanceContextProvider` 실 구현            | auto-reply 품질 개선 의제          | Phase 25 에서 memories 배선과 함께 |
| 거래 내역(`transactions`) 테이블                | 설계 자체가 큰 작업                | **Phase 25 가칭**                  |
| 모델 역할 라우팅                                | 본 Phase 핵심에서 분리 결정        | **Phase 24 가칭**                  |

---

## 개선 여지 (다음 Phase 에서 고려)

1. **RPC 에러 코드 확장**: 현재 모든 커스텀 에러가 `-32603 INTERNAL_ERROR` 로 집계됨. `provider_unavailable` / `invalid_symbol` / `unknown_agent` / `stream_unsupported` 같은 것을 `-32010 ~ -32099` 범위로 정식화하면 클라이언트 분기 쉬움.
2. **agent.run 타임아웃 메시지**: `AbortController.abort()` 결과가 `runner.execute` 에서 어떻게 올라오는지 E2E 미검증 (단위 테스트는 mock). 실제 Anthropic 호출 중 취소 시 graceful 실패 여부 확인 필요.
3. **Web Portfolio 뷰 자동 갱신**: 현재 수동 새로고침만. WebSocket `portfolio.changed` notification 으로 자동 갱신 (Phase 25 거래 기록 추가 시 자연스럽게).
4. **AlertStore.listByUser 의 userId='default' 하드코딩**: 멀티 유저 확장 시 RPC 에서 auth 컨텍스트 → userId 매핑 필요.

---

## 검증 결과

- ✅ `pnpm build` (tsc --build) — 에러 0
- ✅ `pnpm typecheck` (tsgo) — 에러 0
- ✅ `pnpm lint` (oxlint) — 0 warnings / 0 errors
- ✅ `pnpm test` — 147 files / **1311 tests** 통과 (finance.test +19, agent.test +10 신규)
- ✅ Web 번들 — 108 KB / gzip 34 KB
- ✅ Pre-commit hooks (typecheck / lint / format-check / conventional) 모두 통과

---

## 🧪 사용자 직접 검증 체크리스트

아래는 실제 환경에서 돌려보며 눈으로 확인할 항목. **단위 테스트는 mock 기반이라 실제 HTTP/외부 API 동작은 수동 검증**이 필요하다.

### 0. 준비

```bash
# 필요 환경변수
export ANTHROPIC_API_KEY=sk-ant-...          # 필수 (agent.run)
export ALPHA_VANTAGE_KEY=...                  # 선택 (finance.quote/news)
export COINGECKO_API_KEY=...                  # 선택 (crypto)
export FINCLAW_API_KEY=test-token             # RPC 인증용
export DISCORD_TOKEN=...                      # 선택 (Discord 경로 회귀 확인)

pnpm dev   # 서버 기동
```

### 1. 기동 & 등록 확인

- [ ] 서버 로그에 `finance.* / agent.* RPC methods wired` 라인 출력
- [ ] `curl http://localhost:3000/info` 응답의 `methods` 배열에 다음 8개 포함:
  - `finance.quote` / `finance.news` / `finance.alert.create` / `finance.alert.list` / `finance.portfolio.get`
  - `agent.list` / `agent.status` / `agent.run`

### 2. `finance.*` RPC 직접 호출

모든 요청에 `-H "Authorization: Bearer $FINCLAW_API_KEY" -H "Content-Type: application/json"` 필요. 아래 예시는 생략.

```bash
# 시세
curl -X POST http://localhost:3000/rpc -d '{"jsonrpc":"2.0","id":1,"method":"finance.quote","params":{"symbol":"AAPL"}}'
```

- [ ] 실제 가격이 포함된 JSON (price/change/changePercent/timestamp)
- [ ] `"symbol":"AAPL"` 대문자 변환 확인
- [ ] `BTC` 로 재시도 → crypto 가격 반환 (COINGECKO 키 있을 때)
- [ ] `INVALIDXX` → 에러 메시지에 `invalid_symbol` 포함

```bash
# 뉴스
curl ... -d '{"jsonrpc":"2.0","id":1,"method":"finance.news","params":{"query":"tesla","limit":5}}'
```

- [ ] `articles` 배열 (title/url/source/publishedAt)
- [ ] `limit: 999` 로 시도 → 응답에 50개 이하 (클램핑)

```bash
# 알림 — 즉시 충족 (AAPL 현재가 > 1)
curl ... -d '{"jsonrpc":"2.0","id":1,"method":"finance.alert.create","params":{"symbol":"AAPL","condition":"price_above","threshold":1}}'
```

- [ ] 응답 `immediateTrigger: true`
- [ ] Discord 연동 시 DM 으로 즉시 알림 도착 (선택)

```bash
# 알림 — 미충족
curl ... -d '{"jsonrpc":"2.0","id":1,"method":"finance.alert.create","params":{"symbol":"AAPL","condition":"price_above","threshold":99999}}'
```

- [ ] 응답 `immediateTrigger: false`

```bash
# 알림 목록
curl ... -d '{"jsonrpc":"2.0","id":1,"method":"finance.alert.list","params":{}}'
```

- [ ] 위에서 생성한 알림 2개 포함, `triggerCount`/`enabled` 필드 확인
- [ ] `{"symbol":"TSLA"}` 필터 추가 → AAPL 알림 제외됨

```bash
# 포트폴리오
curl ... -d '{"jsonrpc":"2.0","id":1,"method":"finance.portfolio.get","params":{}}'
```

- [ ] DB 에 포트폴리오 없으면 `{holdings:[], summary:{currency:'USD'}}`
- [ ] 채팅에서 `!finclaw` 로 포트폴리오 종목 추가 후 재호출 → holdings 반영

```bash
# API 키 없을 때
ALPHA_VANTAGE_KEY= pnpm dev
curl ... finance.quote ...
```

- [ ] 에러 메시지에 `provider_unavailable` 포함

### 3. `agent.*` RPC

```bash
# 목록
curl ... -d '{"jsonrpc":"2.0","id":1,"method":"agent.list","params":{}}'
```

- [ ] `agents` 배열에 `finclaw-partner` 1개 + `toolCount`

```bash
# 실행 (datetime 도구 호출되는 경로)
curl ... -d '{"jsonrpc":"2.0","id":1,"method":"agent.run","params":{"agentId":"finclaw-partner","prompt":"지금 몇 시야?"}}'
```

- [ ] 응답 `output` 에 현재 시각 언급
- [ ] `toolCalls` 에 `get_current_datetime` 기록
- [ ] `tokenUsage.input/output` 0 이상
- [ ] `durationMs` 수천 ms 수준
- [ ] `stopReason: 'completed'`

```bash
# 상태
curl ... -d '{"jsonrpc":"2.0","id":1,"method":"agent.status","params":{"agentId":"finclaw-partner"}}'
```

- [ ] `totalCalls: 1` (위 run 이후)
- [ ] `lastCallAt` 최근 타임스탬프
- [ ] `health: 'healthy'`

```bash
# 스트리밍 거부
curl ... -d '{"jsonrpc":"2.0","id":1,"method":"agent.run","params":{"agentId":"finclaw-partner","prompt":"hi","stream":true}}'
```

- [ ] 에러 `stream_unsupported`

```bash
# 미지의 에이전트
curl ... -d '{"jsonrpc":"2.0","id":1,"method":"agent.run","params":{"agentId":"nobody","prompt":"hi"}}'
```

- [ ] 에러 `unknown_agent`

```bash
# 큐잉 — 2개 동시 요청 (다른 터미널 2개)
(curl ... agent.run first &) && (curl ... agent.run second &)
```

- [ ] 서버 로그에서 `agent.run.started` 가 순차로 찍힘 (두 번째가 첫 번째 `completed` 후에 시작)

### 4. Web UI

```bash
# 서버는 3000, web dev 서버
pnpm --filter @finclaw/web dev
# 브라우저: http://localhost:5173?token=$FINCLAW_API_KEY&gateway=http://localhost:3000
```

- [ ] 우측 하단 상태 "Connected"
- [ ] **Market 탭**: `AAPL` 입력 → 카드 (가격·변동률·색상)
- [ ] Market 에 `INVALIDXX` → 에러 박스
- [ ] **Portfolio 탭**: 자동 로드, 빈 상태면 "거래 기록 기능은 Phase 25 예정" 문구
- [ ] 새로고침 버튼 동작
- [ ] **Alerts 탭**: 방금 curl 로 생성한 알림 리스트 표시
- [ ] 추가 폼에서 "AAPL / 가격 상향 / 1" → 녹색 "이미 조건 충족" 메시지 + 리스트 즉시 갱신
- [ ] `news_match` 선택 → threshold 인풋이 키워드 인풋으로 바뀜

### 5. 회귀 (Phase 22 유지)

- [ ] Discord DM 에서 `!finclaw` 로 일반 질문 → AI 응답 (기존 대화 경로 유지)
- [ ] Discord 에서 "AAPL 시세" 요청 → Claude 가 `get_stock_price` 호출해 답변
- [ ] `!finclaw status` 출력 여전히 동작
- [ ] 가격 알림 자동 체크 (30초 주기) 여전히 동작
- [ ] 응답 꼬리에 `📊 출처: ...` footer 유지

### 6. 감사 로그

- [ ] `agent.run` 호출 후 로그에 `{event: 'agent.run.started', agentId, promptLength}` 기록
- [ ] 완료 시 `{event: 'agent.run.completed', durationMs, tokensInput, tokensOutput, toolCallCount}` 기록
- [ ] 실패 시 `{event: 'agent.run.failed', error, durationMs}` 기록

### 7. 환경변수 부분 설정 (graceful skip)

- [ ] `ALPHA_VANTAGE_KEY` 만 있고 `COINGECKO_API_KEY` 없음 → 주식은 되고 crypto 만 실패
- [ ] 둘 다 없음 → `finance.quote` 전체 `provider_unavailable`
- [ ] `ANTHROPIC_API_KEY` 만 없음 → 서버 기동 실패 또는 `agent.run` 실패

---

## Done

Phase 23 범위 내 모든 Todo 완료. 다음 단계:

1. **즉시**: 위 체크리스트 1·2·3 으로 기동 후 smoke test
2. **선택**: Phase 24 (모델 라우팅) 또는 Phase 25 (기억·거래) 중 우선순위에 따라 시작. 계획 문서는 이미 `plans/phase24/plan.md` / `plans/phase25/plan.md` 에 준비됨.

---

## Post-ship Fix — HTTP `/rpc` 인증 누락 (2026-04-25)

Smoke test 중 외부 `curl` 로 `finance.*` / `agent.*` 호출 시 전부 `-32001 Insufficient permissions` 반환되어 추적한 결과, **router.ts 의 HTTP `/rpc` 엔드포인트가 인증 자체를 실행하지 않고 `auth: { level: 'none', permissions: [] }` 을 하드코딩**하고 있는 것을 발견.

- **영향 범위**: HTTP 경로로 들어온 `token` 요구 RPC 메서드가 전부 차단. 즉 Phase 23 의 핵심 목표 "AI 외부 접근 경로 (curl / 스크립트 / 크론 / 서드파티)" 가 **HTTP 로는 동작 안 함**. WebSocket (브라우저 Web UI) 경로는 `ws/connection.ts:33` 에서 `authenticate()` 를 올바르게 호출하고 있어 영향 없음.
- **보안 관점**: "인증 없이 통과" 가 아니라 "항상 level=none 으로 처리" 이므로 외부 악용 가능성은 없음 (public 메서드만 통과). 그러나 의도한 설계 아님.
- **원인 위치**: `packages/server/src/gateway/router.ts:100-107` — Phase 22 이전부터 있던 기존 버그. Phase 23 작업과 무관하게 존재했으나 이번 smoke test 에서 처음 관찰됨.

### 수정

WebSocket 경로와 동일한 패턴으로 `authenticate()` 호출 + 결과 전달:

```ts
// router.ts handleRpcRequest 내부
const authResult = await authenticate(req, ctx.config.auth);
if (!authResult.ok) {
  res.writeHead(authResult.code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(createError(null, RpcErrors.UNAUTHORIZED, authResult.error)));
  return;
}
const response = await dispatchRpc(
  parsed as Parameters<typeof dispatchRpc>[0],
  { auth: authResult.info, remoteAddress: req.socket.remoteAddress ?? 'unknown' },
  ctx,
);
```

### 테스트 추가 (`router.test.ts`)

| 케이스                                              | 기대                  |
| --------------------------------------------------- | --------------------- |
| Authorization 헤더 없이 `token` 레벨 메서드 호출    | `-32001 UNAUTHORIZED` |
| 유효한 HS256 JWT Bearer 로 `token` 레벨 메서드 호출 | `result.ok: true`     |

기존 11 케이스 전부 유지 (Authorization 없는 요청은 여전히 `level: 'none'` 으로 처리되어 기존 기대 동작 보존).

### 관련 이슈 (수정 대상 아님)

- **`?token=` 쿼리는 JWT 만 받음** (`auth/index.ts:34`): 보안 설계상 의도된 동작. API key 는 X-API-Key 헤더 전용. 브라우저용 JWT 생성 CLI 추가는 Phase 24+ 편의 개선 의제로 분리.

### 검증 절차

```bash
# HS256 JWT 생성 (secret: GATEWAY_JWT_SECRET 또는 'dev-secret')
node -e "
const { createHmac } = require('crypto');
const secret = process.env.GATEWAY_JWT_SECRET || 'dev-secret';
const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const h = b64url({ alg:'HS256', typ:'JWT' });
const p = b64url({ sub:'dev', permissions:[] });
const s = createHmac('sha256', secret).update(h+'.'+p).digest('base64url');
console.log(h+'.'+p+'.'+s);
"

# 이후 토큰을 Bearer 로 넣어 HTTP /rpc 호출
curl -s -X POST http://localhost:3000/rpc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <JWT>" \
  -d '{"jsonrpc":"2.0","id":1,"method":"finance.portfolio.get","params":{}}'
# → {result: {holdings: [...], summary: {...}}}
```

Web UI 접속 URL (브라우저):

```
http://localhost:5173?token=<JWT>&gateway=http://localhost:3000
```
