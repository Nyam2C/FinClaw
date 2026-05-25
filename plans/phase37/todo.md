# Phase 37 Todo: 감사 후속 — chat auth 강등 + 싼 P1 정리 (config 스키마 · FTS 임계 · 클라 드리프트)

> `plans/phase37/plan.md` 의 4 밀스톤(A/B/C/D)을 코드 단위로 분해. 외과적 — plan 의 4건만. **비대상**: P0-2(CLI 미등록 메서드 system.shutdown/finance.alert.remove/channel.\*), P1-6(tier 발산), P2 dead code, 서버 RPC 계약 변경. 항목 D 는 **서버 shape/method 불변, 클라만** 고친다.
>
> 코드 앵커는 전부 실측 재확인 완료 (2026-05-25, main HEAD = phase36 머지 후). 밀스톤 = 1 커밋.

---

## 사전 준비

별도 의존성·schema bump·패키지 신설 없음. 전부 기존 파일 외과 수정. 진입 base = 현재 main HEAD (phase36 머지 #71 이후).

---

## 밀스톤 A — chat auth 강등 (`'session'` → `'token'`)

> plan 항목 1 / 감사 F1(P0). `chat.send`/`chat.stop` 의 `authLevel:'session'` 이 영구 도달 불가(인증 파이프라인 최대 `'token'`) → web/tui 채팅 전송 100% UNAUTHORIZED. 미구현 세션 인증 의도가 아니라 `'token'` 으로 강등해 해결 (사용자 결정). chat.start/chat.history 가 이미 `'token'` 이라 chat.\* 전부 일관.

### A1. EDIT `packages/server/src/gateway/rpc/methods/chat.ts` — chat.send / chat.stop authLevel 강등

두 곳만 변경. `sendHandler`(현재 `:80`)와 `stopHandler`(현재 `:137`)의 `authLevel`.

```ts
// sendHandler (chat.send)
  > = {
    method: 'chat.send',
    description: '활성 세션에 메시지를 전송합니다',
    authLevel: 'token', // ← 'session' 에서 강등 (Phase 37 A: session 레벨은 부여 코드 부재 → 영구 도달 불가)
    schema: z.object({
      // ... 기존 schema 유지 ...
```

```ts
// stopHandler (chat.stop)
  const stopHandler: RpcMethodHandler<{ sessionId: string }, { stopped: boolean }> = {
    method: 'chat.stop',
    description: '활성 세션을 중단합니다',
    authLevel: 'token', // ← 'session' 에서 강등 (Phase 37 A)
    schema: z.object({
      sessionId: z.string(),
    }),
```

> chat.start(`:51`)·chat.history(`:152`)는 이미 `'token'` — 변경 없음. 핸들러 본문·schema·로직 일체 불변. authLevel 문자열 2개만.

검증: `pnpm --filter @finclaw/server build`

### A2. EDIT `packages/server/src/gateway/rpc/methods/chat.test.ts` — 깨진 계약 테스트 재작성 + fixture 갱신

세 군데. (1) schema-validation 테스트 fixture 의 `level:'session'`(`:104`, `:113`) → `'token'`. (2) "requires session level" 테스트(`:144`)를 "requires token level / rejects below token" 로 재작성.

**(1) `chat.send rejects missing sessionId` (`:101~108`)** — auth fixture 만 교체 (의도: schema 검증 도달 위해 auth 통과):

```ts
it('chat.send rejects missing sessionId', async () => {
  const result = await dispatchRpc(
    { jsonrpc: '2.0', id: 1, method: 'chat.send', params: { message: 'hi' } },
    { auth: { level: 'token', permissions: [] }, remoteAddress: '127.0.0.1' }, // ← 'session' → 'token'
    ctx,
  );
  expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
});
```

**(2) `chat.send rejects missing message` (`:110~117`)** — 동일하게 auth fixture `'session'` → `'token'`:

```ts
it('chat.send rejects missing message', async () => {
  const result = await dispatchRpc(
    { jsonrpc: '2.0', id: 1, method: 'chat.send', params: { sessionId: 's1' } },
    { auth: { level: 'token', permissions: [] }, remoteAddress: '127.0.0.1' }, // ← 'session' → 'token'
    ctx,
  );
  expect((result as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
});
```

**(3) `auth requirements` 의 `chat.send requires session level` (`:144~156`)** — 통째로 재작성. 깨진 계약(token 거부 기대)을 화석화하던 테스트를 "token 은 통과(= UNAUTHORIZED 아님), token 미만(api_key)은 거부" 로 교체:

```ts
it('chat.send accepts token level (rejects below token)', async () => {
  // token 미만(api_key)은 거부
  const denied = await dispatchRpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'chat.send',
      params: { sessionId: 's1', message: 'hi' },
    },
    { auth: { level: 'api_key', permissions: [] }, remoteAddress: '127.0.0.1' },
    ctx,
  );
  expect((denied as { error: { code: number } }).error.code).toBe(RpcErrors.UNAUTHORIZED);

  // token 은 auth 게이트 통과 → UNAUTHORIZED 가 아님.
  // 세션 미존재로 INTERNAL_ERROR('session not found') 이 나지만, 그건 auth 통과 후의 핸들러 에러.
  const passed = await dispatchRpc(
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'chat.send',
      params: { sessionId: 's1', message: 'hi' },
    },
    { auth: { level: 'token', permissions: [] }, remoteAddress: '127.0.0.1' },
    ctx,
  );
  expect((passed as { error?: { code: number } }).error?.code).not.toBe(RpcErrors.UNAUTHORIZED);
});
```

> 주의: `passed` 케이스는 `s1` 세션이 registry 에 없으므로 핸들러가 `throw new Error('session not found')` → dispatcher 가 INTERNAL_ERROR 로 wrap. 따라서 `error.code` 가 존재하되 **UNAUTHORIZED 가 아님** 을 assert (auth 게이트 통과를 입증). 정확한 INTERNAL_ERROR 코드값은 구현 시 `RpcErrors` 실측으로 확정. `chat.stop` 도 동일 패턴이나 plan 이 send 만 명시 — stop 은 authLevel 변경(A1)으로 충분, 신규 테스트 강제 X (기존 send 테스트로 게이트 회귀 커버).

검증: `pnpm --filter @finclaw/server test --run -- chat.test`

### A3. 밀스톤 A 검증

다음을 모두 통과해야 다음 밀스톤으로:

- `pnpm typecheck`
- `pnpm --filter @finclaw/server test --run -- chat.test`
- `pnpm --filter @finclaw/server build`

---

## 밀스톤 B — config Zod strict 스키마 갭

> plan 항목 2 / 감사 P1-1. `FinClawConfig` 타입엔 `rag?`·`accessLog?`·gateway `auth?:{token?}` 가 있고 런타임 소비되나(`runtime.ts:174`, `main.ts:353`, `cli/commands/tui.ts:18`), Zod 루트 `FinClawConfigSchema`(strictObject)엔 `rag`/`accessLog` 없고 `GatewaySchema` 엔 `auth` 없음. → 사용자가 이 옵션을 config 에 쓰면 `validateConfigStrict` 가 `Unrecognized key` throw → 기동 불가. 타입(`types/config.ts`)을 진실원으로 Zod 1:1 미러.

### B1. EDIT `packages/config/src/zod-schema.ts` — RagSchema / AccessLogSchema 신설 + GatewaySchema.auth 추가 + 루트 키 2개

**(1) `GatewaySchema`(`:5~10`)에 `auth` 추가** — 타입 `GatewayConfig.auth?:{token?:string}`(`types/config.ts:83`) 미러:

```ts
/** 게이트웨이 설정 스키마 */
const GatewaySchema = z.strictObject({
  port: z.number().int().min(1).max(65535),
  host: z.string(),
  tls: z.boolean(),
  corsOrigins: z.array(z.string()),
  // Phase 37 B: 타입 GatewayConfig.auth?:{token?:string} 미러 (cli/commands/tui.ts:18 소비).
  auth: z.strictObject({ token: z.string().optional() }).optional(),
});
```

**(2) 파일 상단(GatewaySchema 정의 부근, import 직후)에 `AccessLogSchema` / `RagSchema` 신설** — 타입 `AccessLogConfig`(`:35~38`) / `RagConfig`(`:40~49`) 1:1:

```ts
/** Phase 37 B: access-log retention 스키마 (types AccessLogConfig 미러). */
const AccessLogSchema = z.strictObject({
  retentionDays: z.number().int().optional(),
});

/** Phase 37 B: RAG re-ranking 토글 스키마 (types RagConfig 미러). */
const RagSchema = z.strictObject({
  rerank: z
    .strictObject({
      enabled: z.boolean().optional(),
      topKFirst: z.number().int().optional(),
      topKFinal: z.number().int().optional(),
    })
    .optional(),
});
```

**(3) 루트 `FinClawConfigSchema`(`:154~`)에 `accessLog` / `rag` 키 추가** — 기존 `meta`/`provider`/`cliBackend` 와 같은 레벨. 삽입 위치는 `routing` 뒤·`meta` 앞이 자연스러움(타입 선언 순서와 맞춤):

```ts
  finance: FinanceSchema.optional(),
  routing: RoutingConfigSchema.optional(),
  // Phase 37 B: 타입 FinClawConfig.accessLog?·rag? 미러 (런타임 소비: main.ts:353, runtime.ts:174).
  accessLog: AccessLogSchema.optional(),
  rag: RagSchema.optional(),
  meta: z
    .strictObject({
      // ... 기존 meta ...
```

> 전부 `z.strictObject(...).optional()` + 내부 필드 `.optional()` — 타입의 `?` 와 정확히 대응. enum/숫자 범위 등 추가 제약은 타입에 없으므로 넣지 않음 (over-constraint 금지, CLAUDE.md §2). `defaults.ts` 는 `rag`/`accessLog` 를 주입하지 않으므로(기본 부팅 정상) 변경 불필요 — B 범위 밖.

검증: `pnpm --filter @finclaw/config build`

### B2. EDIT `packages/config/test/zod-schema.test.ts` — 회귀 테스트 (rag/accessLog/gateway.auth 통과)

기존 strict-reject 테스트(`:41` "알 수 없는 키를 거부한다") 옆, describe 블록 끝(`:108` 직전)에 통과 케이스 추가. plan 완료조건 #2 와 1:1.

```ts
it('rag / accessLog / gateway.auth 키를 허용한다 (Phase 37 B)', () => {
  const result = FinClawConfigSchema.safeParse({
    rag: { rerank: { enabled: true, topKFirst: 10, topKFinal: 3 } },
    accessLog: { retentionDays: 7 },
    gateway: { port: 18789, host: 'localhost', auth: { token: 'x' } },
  });
  expect(result.success).toBe(true);
});

it('rag.rerank 의 알 수 없는 키를 거부한다 (strictObject 유지)', () => {
  const result = FinClawConfigSchema.safeParse({
    rag: { rerank: { foobar: true } },
  });
  expect(result.success).toBe(false);
});
```

> 두 번째 케이스는 strict 가 살아있음을(오타 방지 회귀) 확인. plan 의 "타입과 1:1 + strict 유지" 의도 보존.

검증: `pnpm --filter @finclaw/config test --run -- zod-schema`

### B3. (선택) EDIT `packages/config/test/validation.test.ts` — validateConfigStrict throw-안함 회귀

`validation.test.ts` 에 `validateConfigStrict` 케이스가 이미 있으면 그 옆에 추가. 감사 재현 케이스(`validateConfigStrict({rag:{...}})` 가 더는 throw 안 함)를 직접 커버:

```ts
it('rag/accessLog/gateway.auth 포함 config 를 throw 없이 통과 (Phase 37 B 회귀)', () => {
  expect(() =>
    validateConfigStrict({
      rag: { rerank: { enabled: true } },
      accessLog: { retentionDays: 7 },
      gateway: { auth: { token: 'x' } },
    }),
  ).not.toThrow();
});
```

> `validation.test.ts` 의 기존 import/구조 실측 후 배치. 파일에 적당한 describe 가 없으면 B2 의 zod-schema 테스트만으로도 완료조건 #2 충족 — 이 단계는 보강용(스키마 레벨 + 검증 함수 레벨 이중 커버). 파일 부재/형태 불일치 시 skip 가능.

검증: `pnpm --filter @finclaw/config test --run`

### B4. 밀스톤 B 검증

- `pnpm typecheck`
- `pnpm --filter @finclaw/config test --run`
- `pnpm --filter @finclaw/config build`

---

## 밀스톤 C — FTS-only RAG fallback 임계 분리

> plan 항목 3 / 감사 P1-2. `SIMILARITY_THRESHOLD=0.65`(코사인 가정) 컷이 `memory-retrieval.ts:291` 에서 **mode 무관** 적용 → 임베딩 미주입/장애(FTS-only) 시 다중어 질의(BM25 파생 0.54/0.60)가 0건 주입. **실측 분기 설계 (코드 확인 완료):**
>
> - `mergeHybridResults`(`storage/src/search/hybrid.ts:147`)는 병합 결과 source 를 **항상 `'hybrid'`** 로 덮어씀 → hybrid 경로 결과는 source 로 vector/fts 구분 불가. 하지만 **fts-only 경로**(`memory-retrieval.ts:271,274`)는 `searchFts` 결과를 그대로 써 source=`'fts'` + **outer `mode` 변수가 `'fts-only'`**.
> - 따라서 **mode 변수**로 분기하는 게 가장 깔끔: `mode==='hybrid'` → 0.65 코사인 컷 유지 (vector 0.7 가중이 지배, BM25 가중 0.3 단독 기여분은 구조적으로 0.65 도달 어려움이나 hybrid 합산점수엔 0.65 가 적정). `mode==='fts-only'` → 별도 임계(FTS_SIMILARITY_THRESHOLD) 적용.
> - FTS-only 임계값: `bm25RankToScore = 1/(1+|rank|)`. 다중어 AND-match 의 관측 점수 0.54/0.60 을 살리고, 단일어(1.0)·무관(0)을 가르려면 **0.3** 이 합리 (0 직상 노이즈는 거르되 0.5+ 의 진짜 다중어 매치는 통과). 상한·dedup·신선도 정렬은 mode 무관 그대로 유지.

### C1. EDIT `packages/server/src/auto-reply/stages/memory-retrieval.ts` — FTS 전용 임계 상수 + mode 별 컷

**(1) 상수 추가 (`:17` `SIMILARITY_THRESHOLD` 바로 아래)**:

```ts
/** raw 점수 컷오프. 무관 발화에 무관 기억이 끼지 않게 하는 마지노선. (vector/hybrid 코사인 기준) */
export const SIMILARITY_THRESHOLD = 0.65;

/**
 * Phase 37 C: FTS-only fallback 전용 컷오프.
 * bm25RankToScore = 1/(1+|rank|) 스케일은 코사인과 다름 — 다중어 AND-match 가 0.5~0.6 대.
 * 0.65 코사인 컷을 그대로 적용하면 2어 이상 질의가 조용히 0건. 0.3 으로 분리해 회상 누락 방지.
 */
export const FTS_SIMILARITY_THRESHOLD = 0.3;
```

**(2) 컷 분기 (현재 `:291` `if (rawScore < SIMILARITY_THRESHOLD) continue;`)** — `mode` 에 따라 임계 선택:

```ts
    // 3. memory 메타 로드 + 임계값/신선도 적용
    const now = Date.now();
    const candidates: MemorySnippet[] = [];
    // Phase 37 C: mode 별 컷오프 — fts-only 는 BM25 스케일이라 코사인 0.65 컷이 과함.
    const scoreThreshold = mode === 'fts-only' ? FTS_SIMILARITY_THRESHOLD : SIMILARITY_THRESHOLD;
    for (const r of bestByMemory.values()) {
      const rawScore = r.score;
      if (rawScore < scoreThreshold) {
        continue;
      }
      // ... 기존 getMemory / SEARCHABLE_TYPES / 신선도 로직 그대로 ...
```

> dedup(`bestByMemory`)·신선도(`exp(-daysOld/90)`)·상한(`MAX_INJECTED_MEMORIES=3`)·정렬·rerank·거래주입 전부 불변. 단일 분기점(컷 임계)만 mode-aware. hybrid 경로는 0.65 유지(회귀 없음). 임베딩 장애 fallback(`:270` `mode='fts-only'` 재할당)도 같은 `mode` 변수를 읽으므로 자동 커버.

검증: `pnpm --filter @finclaw/server build`

### C2. EDIT `packages/server/src/auto-reply/__tests__/memory-retrieval.storage.test.ts` — 다중어 FTS-only 회상 회귀 테스트

기존 `describe('DefaultMemoryRetrievalService — fts-only mode', ...)` 블록(`:395~458`) 안에 추가. plan 완료조건 #3 와 1:1 — 임베딩 미주입 + 다중어 질의가 0건 아님.

```ts
it('다중어 FTS-only 질의가 회상 0건이 아니다 (Phase 37 C 회귀)', async () => {
  // 감사 P1-2 재현 케이스: "분기별 리밸런싱" 류 다중어 AND-match (BM25 0.5~0.6 대).
  await seedMemory(database, undefined, {
    content: '분기별 리밸런싱 원칙: 목표 비중에서 5%p 벗어나면 조정',
    type: 'fact',
    createdAt: Date.now() - 24 * 60 * 60 * 1000,
  });
  const service = new DefaultMemoryRetrievalService({
    db: database.db,
    logger,
  });
  const result = await service.searchRelevant({
    userQuery: '분기별 리밸런싱',
    sessionKey,
  });
  expect(result.mode).toBe('fts-only');
  // Phase 37 C 이전: BM25 0.54/0.60 < 0.65 → 0건. 분리 후 0.3 컷 통과.
  expect(result.snippets.length).toBeGreaterThan(0);
  expect(result.snippets[0]?.content).toContain('리밸런싱');
});
```

> `seedMemory(database, undefined, ...)` 는 provider 없는 FTS-only 경로(`addMemory` 만). 실 BM25 점수는 trigram 코퍼스에 의존하므로 **구현 시 실제 점수 로그로 0.3 컷 적정성 재확인** — 만약 단일 문서 코퍼스라 점수가 예상과 다르면 (a) 코퍼스에 noise 문서 1-2개 추가(`bm25RankToScore` 가 상대 rank 의존) 또는 (b) `FTS_SIMILARITY_THRESHOLD` 값 미세조정. 단일어 통과(`기존 :408` 케이스)는 회귀 없음(1.0 > 0.3).
>
> **임계 적정성 실측 의존성**: 0.3 은 감사 보고의 0.54/0.60 관측 + 단일어 1.0 사이 합리적 분리점이나, 구현 단계에서 이 테스트가 실제로 통과하는지 + 무관 발화(`:380` "아무것도 매칭되지 않을 임의 문구" 케이스)가 여전히 0건인지 둘 다 확인. 무관 케이스가 0.3 으로 새면 임계 상향 또는 buildFtsQuery AND-match 특성으로 자연 0 hits 인지 확인.

검증: `pnpm --filter @finclaw/server test --run -- memory-retrieval`

### C3. 밀스톤 C 검증

- `pnpm typecheck`
- `pnpm --filter @finclaw/server test --run -- memory-retrieval`
- `pnpm test:storage` (FTS 경로가 storage 검색 함수 의존 — 회귀 없음 확인)
- `pnpm --filter @finclaw/server build`

---

## 밀스톤 D — 클라이언트 드리프트 4건 (서버 shape/method 불변, 클라만)

> plan 항목 4 / 감사 F5~F8(P1). 서버 RPC 계약 정상, 클라가 어긋남. **서버 일체 불변.** F5 web 세션 부트, F6 agent.status param, F7 alert.list shape, F8 news shape.

### D1. EDIT `packages/web/src/app-chat.ts` — 서버 발급 sessionId 늦은 바인딩 (F5 클라 측)

> **설계 (TUI 작동 경로 미러)**: TUI(`tui/src/App.tsx:49~53`)는 connect 후 `chat.start({agentId})` → 반환 sessionId 를 `chat.send` + 알림 필터에 사용. web 은 `app.ts:157` 에서 random sessionId 를 만들어 그대로 씀 → 서버 세션과 불일치 → `session not found`.
>
> **제약**: `createAppChat(gateway, sessionId)` 생성자 시그니처를 **유지** (기존 `__tests__/app-chat.test.ts:41` 가 `createAppChat(gateway, SESSION)` + `chat.send` 가 `{sessionId: SESSION}` 임을 assert). 따라서 생성자는 그대로 두고 **`setSessionId(id)` 메서드를 추가**해 늦은 바인딩. 내부 `sessionId` 를 `let` 으로 바꾸고 send/notification-filter 가 현재 값을 읽게 함.

`app-chat.ts` 변경:

```ts
// AppChat 인터페이스에 setSessionId 추가
export interface AppChat {
  sendMessage(text: string): Promise<void>;
  setSessionId(id: string): void; // ← Phase 37 D(F5): chat.start 후 서버 발급 id 주입
  getState(): ChatState;
  onStateChange(listener: ChatStateListener): void;
  offStateChange(listener: ChatStateListener): void;
  flush(): void;
  dispose(): void;
}
```

```ts
export function createAppChat(gateway: AppGateway, sessionId: string): AppChat {
  // Phase 37 D(F5): chat.start 후 setSessionId 로 교체 가능하도록 let.
  let currentSessionId = sessionId;
  let state: ChatState = {
    // ... 기존 ...
```

```ts
  function handleNotification(method: string, params: Record<string, unknown>): void {
    const p = params as Record<string, unknown>;
    if (p['sessionId'] !== currentSessionId) {  // ← sessionId → currentSessionId
      return;
    }
    // ... 기존 switch ...
```

```ts
    try {
      setState({ status: 'streaming', error: null, streamBuffer: '' });
      await gateway.send('chat.send', { sessionId: currentSessionId, message: text }); // ← currentSessionId
    } catch (err) {
```

```ts
  return {
    async sendMessage(text: string): Promise<void> {
      // ... 기존 ...
    },

    setSessionId(id: string): void {  // ← 신규
      currentSessionId = id;
    },

    getState(): ChatState {
    // ... 기존 ...
```

> 기존 테스트는 `setSessionId` 를 안 부르므로 `currentSessionId === SESSION` 유지 → `app-chat.test.ts` 무회귀. 생성자 초기값이 곧 fallback.

검증: `pnpm --filter @finclaw/web build`

### D2. EDIT `packages/web/src/app.ts` — connect 후 chat.start 호출해 서버 sessionId 사용 (F5 부트 시퀀스)

> `connectedCallback`(`:151~177`)에서 (1) agentId 를 URL `?agent=` 또는 기본값으로 결정, (2) `onConnected` 콜백에서 `chat.start({agentId})` 호출 → 반환 `sessionId` 를 `this.chat.setSessionId(...)`. random sessionId 는 chat.start 성공 전 fallback 으로만 잔존.

```ts
  override connectedCallback(): void {
    super.connectedCallback();
    const params = new URLSearchParams(window.location.search);
    const token = params.get('token') ?? '';
    const gatewayUrl =
      params.get('gateway') ?? `${window.location.protocol}//${window.location.host}`;
    // Phase 37 D(F5): 서버 발급 sessionId 사용. agentId 는 URL 우선, 없으면 'default' (TUI 와 동일).
    const agentId = params.get('agent') ?? 'default';
    const fallbackSessionId = params.get('session') ?? crypto.randomUUID();

    this.gateway.onConnected(() => {
      this.connected = true;
      // chat.start → 서버 발급 sessionId 로 교체. 실패해도 채팅 외 탭은 동작.
      void this.gateway
        .send('chat.start', { agentId })
        .then((res) => {
          const sid = (res as { sessionId?: string } | null)?.sessionId;
          if (sid) {
            this.chat?.setSessionId(sid);
          }
        })
        .catch(() => {
          /* chat.start 실패 시 fallbackSessionId 유지 (채팅은 동작 안 하나 다른 탭 보존) */
        });
    });
    this.gateway.onDisconnected(() => {
      this.connected = false;
    });

    this.chat = createAppChat(this.gateway, fallbackSessionId);
    this.chat.onStateChange((s) => {
      this.chatState = s;
    });

    if (token) {
      this.gateway.connect(gatewayUrl, token);
    }
  }
```

> `agentId` 기본값 `'default'` 는 TUI(`tui/src/index.ts:15`)와 일치 — **결정 확인 필요 항목(questions.md Q1)**. 서버 `chat.start` 는 agentId 를 strict 검증하지 않고 sessionKey 유도에만 씀(`chat.ts:60` deriveTuiSessionKey) → 미존재 agentId 여도 chat.start 자체는 성공, 실제 실행 시 해석. 서버 계약 불변.

검증: `pnpm --filter @finclaw/web build`

### D3. EDIT `packages/server/src/cli/commands/agent.ts` — agent status param `{name}` → `{agentId}` (F6)

서버 schema 가 strict `z.object({ agentId: z.string() })`(`agent.ts:191`) → `{name}` 은 INVALID_PARAMS. 한 줄.

```ts
  cmd
    .command('status <name>')
    .description('show agent status')
    .action(async (name: string) => {
      // Phase 37 D(F6): 서버 schema 는 {agentId} strict — {name} 은 INVALID_PARAMS.
      const result = await deps.callGateway<Record<string, unknown>>('agent.status', {
        agentId: name,
      });
      if (!result.ok) {
        // ... 기존 ...
```

검증: `pnpm --filter @finclaw/server build`

### D4. EDIT `packages/server/src/cli/commands/alert.ts` — alert list `result.alerts` 읽기 (F7)

서버 `finance.alert.list` 반환 `{alerts:[...], total}`(`finance.ts:335`). 현재 `callGateway<...[]>` 로 bare array 단정 → `result.data.length` undefined → 항상 "No alerts". 캐스트 타입 + 추출만 변경.

```ts
cmd
  .command('list')
  .description('list all alerts')
  .action(async () => {
    // Phase 37 D(F7): 서버 반환 {alerts,total} — bare array 아님.
    const result = await deps.callGateway<{ alerts?: Record<string, unknown>[]; total?: number }>(
      'finance.alert.list',
    );
    if (!result.ok) {
      deps.error(theme.error(`Failed to list alerts: ${result.error?.message}`));
      deps.exit(EXIT.GATEWAY_ERROR);
      return;
    }
    const rows = result.data?.alerts ?? [];
    deps.output(rows.length > 0 ? formatTable(rows) : theme.dim('No alerts configured.'));
  });
```

검증: `pnpm --filter @finclaw/server build`

### D5. EDIT `packages/server/src/cli/commands/news.ts` — news `result.articles` 읽기 (F8)

서버 `finance.news` 반환 `{articles:[...], total}`(`finance.ts:248`). 동일 패턴.

```ts
// Phase 37 D(F8): 서버 반환 {articles,total} — bare array 아님.
const result = await deps.callGateway<{ articles?: Record<string, unknown>[]; total?: number }>(
  'finance.news',
  params,
);

if (!result.ok) {
  deps.error(theme.error(`Failed to get news: ${result.error?.message}`));
  deps.exit(EXIT.GATEWAY_ERROR);
  return;
}

const rows = result.data?.articles ?? [];
if (rows.length === 0) {
  deps.output(theme.dim('No news found.'));
  return;
}

if (opts.format === 'json') {
  deps.output(JSON.stringify(rows, null, 2));
} else {
  deps.output(formatTable(rows));
}
```

검증: `pnpm --filter @finclaw/server build`

### D6. 밀스톤 D 검증

- `pnpm typecheck`
- `pnpm --filter @finclaw/web test --run` (app-chat.test 무회귀 — 생성자 시그니처 보존)
- `pnpm --filter @finclaw/web build` + `pnpm --filter @finclaw/server build`
- **수동 검증 권장 (plan 리스크)**: CLI/web 회귀 테스트 커버리지가 얕음. 실 부팅 smoke (서버 기동 후 `finclaw agent status <name>` / `finclaw alert list` / `finclaw news` 가 비-에러 + web 채팅 chat.start→send 순서)는 실 키/네트워크 의존이라 mock-only 자동 테스트 범위 밖 → 사용자 실환경 smoke 와 합류.

---

## 최종 검증

phase 전체 완료 후 다음 모두 통과 (plan 완료조건):

- [ ] `pnpm typecheck`
- [ ] `pnpm test --run`
- [ ] `pnpm test:storage`
- [ ] `pnpm lint`
- [ ] `pnpm build`
- [ ] mock-only 격리: API 키 unset 상태에서 `pnpm test --run` 통과 (실 네트워크/키 호출 0)
- [ ] `pnpm format:fix` 후 재-typecheck (lefthook pre-commit = typecheck + format 통과)

완료조건 1:1 매핑:

- chat.send/chat.stop 이 `'token'` 으로 동작 (token-level 통과 테스트, session 강제 없음) → **밀스톤 A**.
- `validateConfigStrict` 가 rag/accessLog/gateway.auth 포함 config 를 throw 없이 통과 → **밀스톤 B**.
- 임베딩 미주입(FTS-only) + 다중어 질의가 회상 0건 아님 → **밀스톤 C**.
- web 채팅 chat.start→send 순서, CLI agent status/alert list/news 올바른 shape/param → **밀스톤 D**.

---

## 정리

신규 dead code·orphan import 없음 (전부 기존 파일 외과 수정, 신규 export 는 `FTS_SIMILARITY_THRESHOLD`·`AppChat.setSessionId` 2개 — 둘 다 즉시 소비됨). plan 비대상(P0-2/P1-6/P2/서버 계약)은 손대지 않음.

---

## 롤백 절차

각 밀스톤 독립 커밋 → 단계적 롤백:

- 밀스톤 D 롤백: `git revert {sha-D}` — 클라 드리프트 수정만 제거 (서버 불변이라 안전).
- 밀스톤 C 롤백: `git revert {sha-C}` — FTS 임계 분리 제거 (0.65 mode-무관 복귀).
- 밀스톤 B 롤백: `git revert {sha-B}` — Zod 스키마 키 제거 (opt-in config 다시 거부).
- 밀스톤 A 롤백: `git revert {sha-A}` — authLevel 'session' 복귀 (chat 전송 다시 차단).
- 전체 phase 롤백: `git revert {sha-A}..{sha-D}` 또는 phase 시작 SHA 로 reset.

storage 마이그레이션·SCHEMA_VERSION 변경 없음 → 롤백 시 DB 처리 불필요.
