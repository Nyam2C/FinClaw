# Phase 47 Todo: macOS 캐릭터 챗봇 "핀" + 먼저 알려주는(proactive) 알림

> plan.md 의 밀스톤 M0~M9 를 코드 단위로 분해한 작업 가이드.
> 상태: **확정 — /goal 자율 모드에서 메인이 게이트 1 을 대행 승인 (2026-11-26). 사용자 사후 검토 대상.**
> TQ1~TQ7 은 architect 의 권고 답을 전부 채택했다(근거: `_workspace/phase-execute/47-questions.md`). **M0 는 메인이 수행 완료** — 실 서버(Discord 없음, haiku)에서 캡처한 프레임 23줄이 `_workspace/phase47/frames.jsonl` 에 있다(라벨 16종: chat.start/send/abort/reset 응답, `chat.stream.{delta,tool start,tool end,end,error}`, `-32603 session not found`, 무토큰 `-32001`, `schedule.create/runNow/delete` 응답, `notification.schedule.completed`, `system.shutdown`). 토큰·이메일·홈 경로 0건 확인. `alert.triggered` 는 시세 키가 없어 M1 payload shape 의 합성 프레임을 쓴다(TQ6).
> 작성 2026-11-26 · base = main `566cde9` + plan 커밋 `9955d69` · 브랜치 `feature/phase47-mac-character`
> 결정 출처: `plans/phase47/plan.md`(이하 **plan**). 이 문서는 결정·범위를 확장하지 않는다. plan 과 현재 코드가 어긋나는 곳은 `_workspace/phase-execute/47-questions.md` 의 **TQ 번호**로 표시했고, 스니펫에는 **권고 답을 적용**했다(`[TQ#]`). `Q#`·`D#`·`G#`·`S#`·`P#`·`B#`·`U#` 는 plan 의 번호다.

---

## 0. 읽는 법 · 공통 규칙

- 단계 헤딩: `### M{n}-{k}. {VERB} \`path\` — 설명`. 밀스톤 마지막 단계는 항상 `M{n}-N. 밀스톤 검증`.
- **서버 밀스톤(M1~M4) 게이트** — 밀스톤 단독으로 통과해야 커밋:
  ```bash
  pnpm format:fix && pnpm build && pnpm typecheck && pnpm lint && pnpm format && pnpm test && pnpm test:storage
  ```
  기준선: unit **1007 pass / 133 files**, storage **141 pass / 22 files**, 실패 0. 밀스톤마다 순수치를 커밋 본문에 적는다.
- **Swift 밀스톤(M5~M8) 게이트:**
  ```bash
  cd apps/mac && swift build -c release 2>&1 | tail -3 && swift test 2>&1 | tail -5; cd -
  pnpm format && pnpm lint                     # repo 전체 — apps/mac/README.md·.build/ 무시 여부 확인 [TQ5]
  find apps/mac/Sources -name '*.swift' -exec cat {} + | grep -cv '^[[:space:]]*$'   # D7: ≤ 1,200
  ```
  `swift build` 경고 0 이 목표(Swift 6 언어 모드). 여기서는 Swift 를 컴파일해 볼 수 없었으므로 **Swift 스니펫은 설계 스케치**다 — 시그니처·규칙은 고정, 문법은 `swift build`/`swift test` 루프로 완성한다.
- `oxfmt` 가 import 순서를 재정렬한다 → TS 붙인 뒤 `pnpm format:fix` 필수. 테스트 파일은 `tsc --build` 대상이 아니지만 타입은 맞게 쓴다.
- lint 주의(oxlint): `curly`(모든 if 에 중괄호), `no-non-null-assertion`, `no-explicit-any`.
- 커밋: 밀스톤당 1개, `type(phase47): <ASCII subject>`, 본문 = "왜" + 테스트 순수치, 트레일러 `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`. `--no-verify` 금지. M0 은 커밋 없음.
- 오래 떠 있는 서버(M0·M5·M8 스모크): `HERDR_ENV=1` 이면 전역 지침대로 herdr 옆 패인에 띄우고(기존 패인 재사용 확인), 아니면 Bash `run_in_background`. 다 쓰면 종료·패인 닫기.
- **"사람" 표시 항목은 구현자가 시도하지 않는다**: `.app` GUI 실행(알림 권한 대화상자), 창 키 입력·드래그·포커스 확인(G1·G4, §8-3 사람 항목). review 에 "사람 확인 필요" 로만 남긴다.

## 1. 예상 LOC (비어 있지 않은 줄, 추정)

| M   | 서버 TS 프로덕션 |                                                                             Swift 프로덕션 |                  테스트·픽스처 | 기타                            |
| --- | ---------------: | -----------------------------------------------------------------------------------------: | -----------------------------: | ------------------------------- |
| M0  |                — |                                                                                          — | (`_workspace` 캡처, 커밋 없음) | 캡처 스크립트 ~60 (scratch)     |
| M1  |              +42 |                                                                                          — |                            +60 |                                 |
| M2  |              +55 |                                                                                          — |                           +130 |                                 |
| M3  |              +13 |                                                                                          — |                            +12 | `.env.example` +2               |
| M4  | 0 (프롬프트 +19) |                                                                                          — |                             +2 |                                 |
| M5  |                — |   ~385 (Protocol 100 · Connection 50 [TQ3] · GatewayClient 175 · App(Entry) 18 · Smoke 40) |             ~230 + 픽스처 12줄 | `mac.yml` ~20 · `.gitignore` +2 |
| M6  |                — |                                         ~250 (Reducer 140 [TQ4] · FaceParams 60 · Copy 50) |                           ~220 |                                 |
| M7  |                — |      ~355 (App +52 · Panel 45 · AppModel 70 · CharacterView 105 · Bubble 55 · Snapshot 30) |                              — |                                 |
| M8  |                — | ~210 (Notifier 25 · ChatPanel 45 · AlertForm 70 · AppModel +30 · Bubble +35 · Snapshot +5) |                              — | `bundle.sh` ~30                 |
| M9  |                — |                                                                                          — |                              — | 문서                            |
| 계  |        **~+110** |                                                                   **~1,199 / 1,200** [TQ7] |                          ~+655 |                                 |

## 2. 위험 단계 (리뷰·구현 시 집중)

| 단계                           | 왜 위험한가                                                                                                                                                                                                        | 고정 장치                                                                     |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| **M5-5 `GatewayClient.swift`** | 접속 루프·수신 루프·pending continuation·요청 타임아웃·ping·백오프·재-start 재전송이 한 MainActor 클래스에 얽힌다. continuation 누수/이중 resume, 테스트에서 주입 sleep 이 즉시 반환하면 무한 재접속·즉시 타임아웃 | 가상 시간 `TestClock`(M5-10) + fake 연결, 케이스 14개. 실 서버 S1·S3·S4·S5·S8 |
| M6-3 `CharacterReducer.swift`  | plan 표 + TQ4 빈칸 6개. 행 하나 틀리면 표정이 갇힌다(thinking 고착, offline 해제)                                                                                                                                  | 표 전 행 + 회귀 6종 + TQ4 6건 테스트                                          |
| M7-1·M7-6 패널·App 진입        | Swift 6 MainActor 규칙, `@main enum Entry` 에서 `FinClawMacApp.main()` 분기, nonactivating 패널 키 입력(G4 — 사람)                                                                                                 | `swift build` 경고 0, `--snapshot`(G8)                                        |
| M1-3·M1-6 alerts late-bind     | alerts monitor 는 gateway 보다 먼저 생성·시작된다. 바인딩 전 발화는 throw → alert_history 에 실패 기록(의도)                                                                                                       | delivery 테스트 4건                                                           |

---

## 사전 준비

### P-1. 기준선 확인

```bash
git status                                     # clean, feature/phase47-mac-character
pnpm install --frozen-lockfile
pnpm build && pnpm test && pnpm test:storage   # 1007 / 141 기록
swift --version                                # 6.4 (Xcode 27) — Swift 밀스톤용
which claude && claude --version               # M0·스모크용 (claude login 필요)
```

새 npm 의존성 0, Swift 외부 의존성 0, 마이그레이션 0(SCHEMA_VERSION 12 유지 — `alerts.channels` 는 JSON 컬럼).

---

## 밀스톤 M0 — 실 프레임 캡처 (커밋 없음)

> 목적: Swift 픽스처를 가공 없이 실측 프레임으로. 이 시점 서버 = phase46 코드(M1 이전). 결과물은 `_workspace/phase47/frames.jsonl`(gitignore 됨) — M5-8 에서 정제본을 레포로 옮긴다.

### M0-1. 서버 기동 (Discord 없이, 임시 DB)

phase46 review §2 스모크와 같은 관례. **이 기기 레포 루트에 `.env` 가 없다 → 시세·뉴스 키 없음 → alerts·`route_task` 미등록 [TQ6].** `DISCORD_BOT_TOKEN` 미설정이라 Discord 는 비활성.

```bash
SCR=<scratchpad>/m0 && mkdir -p "$SCR"
lsof -nP -iTCP:3000 -sTCP:LISTEN               # 사용자 서버가 떠 있으면 PORT=3100 사용
PORT=3000
pnpm build
FINCLAW_DB_PATH="$SCR/db.sqlite" GATEWAY_PORT=$PORT node packages/server/dist/main.js > "$SCR/server.log" 2>&1 &
echo $! > "$SCR/server.pid"
# 로그에 'Gateway listening on 127.0.0.1:<PORT>' 가 찍힐 때까지 대기 (Monitor until-loop)
```

- 서버는 부팅마다 `~/.finclaw/gateway.token` 을 재기록한다(phase46 동작, secret 이 같아 사용자 기존 토큰도 유효). DB 는 임시라 사용자 대화·알림을 건드리지 않는다.

### M0-2. CREATE `<scratchpad>/m0/capture.cjs` — 일회성 캡처 스크립트 (레포에 커밋 안 함)

`ws` 는 gateway 의존성(`packages/gateway/node_modules/ws`)을 경로 지정으로 빌린다. 출력 형식 = **한 줄에 `{"name": "...", "raw": "<서버가 보낸 텍스트 프레임 원문>"}`** — `raw` 는 문자열 그대로라 가공이 없다.

```js
// <scratchpad>/m0/capture.cjs — phase47 M0. 실행: REPO=$PWD WS_URL=ws://127.0.0.1:$PORT/ OUT=_workspace/phase47/frames.jsonl node <scratch>/m0/capture.cjs
const { readFileSync, appendFileSync, mkdirSync } = require('node:fs');
const { dirname } = require('node:path');
const { homedir } = require('node:os');
const WebSocket = require(
  require.resolve('ws', { paths: [`${process.env.REPO}/packages/gateway`] }),
);

const URL_ = process.env.WS_URL ?? 'ws://127.0.0.1:3000/';
const OUT = process.env.OUT;
mkdirSync(dirname(OUT), { recursive: true });
const token = readFileSync(`${homedir()}/.finclaw/gateway.token`, 'utf8').trim();
const save = (name, raw) => appendFileSync(OUT, `${JSON.stringify({ name, raw })}\n`);
const open = (headers) =>
  new Promise((res, rej) => {
    const ws = new WebSocket(URL_, { headers });
    ws.once('open', () => res(ws));
    ws.once('error', rej);
  });
let nextId = 1;
const waitFor = (ws, pred, ms = 330_000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout waiting frame')), ms);
    const on = (buf) => {
      const raw = buf.toString();
      const f = JSON.parse(raw);
      if (pred(f)) {
        clearTimeout(t);
        ws.off('message', on);
        res({ raw, f });
      }
    };
    ws.on('message', on);
  });
const rpc = (ws, method, params) => {
  const id = nextId++;
  const p = waitFor(ws, (f) => f.id === id, 30_000);
  ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  return p;
};

(async () => {
  const a = await open({ Authorization: `Bearer ${token}` });
  // notification 은 종류별 첫 1개만 자동 저장 (error 는 아래에서 명시 저장)
  const seen = new Set();
  a.on('message', (buf) => {
    const raw = buf.toString();
    const f = JSON.parse(raw);
    const key = f.method === 'chat.stream.tool' ? `chat.stream.tool.${f.params.phase}` : f.method;
    if (key && key !== 'chat.stream.error' && !seen.has(key)) {
      seen.add(key);
      save(key, raw);
    }
  });

  const start = await rpc(a, 'chat.start', { agentId: 'default' });
  save('chat.start.result', start.raw);
  const sessionId = start.f.result.sessionId;

  // ① 도구 턴 — 키가 없어 route_task 미등록 → get_current_datetime [TQ6]
  const s1 = await rpc(a, 'chat.send', {
    sessionId,
    message: 'get_current_datetime 도구로 지금 시각을 확인해서 한 줄로 알려줘',
  });
  save('chat.send.result', s1.raw);
  await waitFor(a, (f) => f.method === 'chat.stream.end');

  // ② abort — 첫 delta 뒤 중단
  const s2 = await rpc(a, 'chat.send', {
    sessionId,
    message: '한국 주식시장의 역사를 아주 길게 설명해줘',
  });
  const run2 = s2.f.result.runId;
  await waitFor(a, (f) => f.method === 'chat.stream.delta' && f.params.runId === run2);
  await rpc(a, 'chat.abort', { sessionId, runId: run2 });
  save(
    'chat.stream.error.aborted',
    (await waitFor(a, (f) => f.method === 'chat.stream.error')).raw,
  );

  // ③ 없는 세션 → -32603 "session not found"
  save(
    'error.session-not-found',
    (await rpc(a, 'chat.send', { sessionId: 'no-such-session', message: 'x' })).raw,
  );

  // ④ 토큰 없이 → level none 으로 열리고 chat.start 가 -32001
  const b = await open({});
  save('error.unauthorized', (await rpc(b, 'chat.start', { agentId: 'default' })).raw);
  b.close();

  // ⑤ 브리핑 broadcast — deliveryChannel web
  const sc = await rpc(a, 'schedule.create', {
    name: 'm0-capture',
    cron: '0 0 1 1 *',
    agentId: 'default',
    prompt: '한 줄로 인사해줘',
    deliveryChannel: 'web',
    deliveryTarget: 'broadcast',
  });
  await rpc(a, 'schedule.runNow', { scheduleId: sc.f.result.scheduleId });
  await waitFor(a, (f) => f.method === 'notification.schedule.completed'); // seen-set 이 저장

  // ⑥ 종료 — 셸에서 kill -TERM $(cat server.pid)
  console.log('READY_FOR_SIGTERM');
  await waitFor(a, (f) => f.method === 'system.shutdown', 120_000);
  console.log('DONE');
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

실행 순서: 서버 기동(M0-1) → 스크립트 실행 → `READY_FOR_SIGTERM` 이 찍히면 `kill -TERM $(cat "$SCR/server.pid")` → `DONE`.

**캡처 대상 11종**(name 값):

| #   | name                              | 유발 요청                                      |
| --- | --------------------------------- | ---------------------------------------------- |
| 1   | `chat.start.result`               | `chat.start{agentId:'default'}`                |
| 2   | `chat.send.result`                | `chat.send{sessionId,message}`                 |
| 3   | `chat.stream.delta`               | ①의 첫 delta                                   |
| 4   | `chat.stream.tool.start`          | ①의 `mcp__finclaw__get_current_datetime` start |
| 5   | `chat.stream.tool.end`            | ① 같은 도구 end                                |
| 6   | `chat.stream.end`                 | ① 종료                                         |
| 7   | `chat.stream.error.aborted`       | ② `chat.abort` 뒤                              |
| 8   | `error.session-not-found`         | ③                                              |
| 9   | `error.unauthorized`              | ④                                              |
| 10  | `notification.schedule.completed` | ⑤ `schedule.runNow`                            |
| 11  | `system.shutdown`                 | ⑥ SIGTERM                                      |

모델이 ①에서 도구를 부르지 않으면(4·5 누락) ①만 다시 돌린다(메시지 그대로, `chat.reset` 후). `notification.alert.triggered` 는 키가 없어 실측 불가 → M5-8 에서 M1 shape 로 합성 1줄 [TQ6].

### M0-3. 정제 (레포 PUBLIC)

캡처본은 M5-8 에서 레포로 간다. 커밋 전 다음이 **0건**이어야 한다:

```bash
F=_workspace/phase47/frames.jsonl
grep -nE 'eyJ[A-Za-z0-9_-]{10,}' "$F"                      # JWT(토큰)
grep -nE '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}' "$F"   # 이메일
grep -nE "/Users/|$HOME|$(whoami)" "$F"                     # 홈 경로·계정명
grep -nE 'req_[A-Za-z0-9]{8,}|request_id' "$F"             # 실 request_id
grep -nE "$(hostname -s)" "$F"                              # 호스트명
```

규칙: 걸리면 **값만** 중립값으로 치환(`user@example.com`, `/Users/me`, `req_000000`)하고 JSON 구조·키·나머지 텍스트는 그대로. 모델 텍스트에 개인 정보가 섞였으면 그 줄은 다시 캡처. UUID(sessionId·runId·scheduleId)·`toolu_` id·usage·costUsd 는 그대로 둔다(plan M0).

### M0-4. 밀스톤 M0 검증

- `jq -r .name _workspace/phase47/frames.jsonl | sort -u | wc -l` ≥ 11, 위 표의 name 이 전부 있다.
- M0-3 grep 5종 전부 0건.
- 서버 프로세스 종료·포트 해제(`lsof -nP -iTCP:$PORT -sTCP:LISTEN` 비어 있음), 고아 `claude -p` 0.
- 모자라면 M5 착수 전에 재캡처. **커밋 없음.**

---

## 밀스톤 M1 — 가격 알림을 websocket 클라이언트로

> 커밋: `feat(phase47): push price alerts to websocket clients`

### M1-1. EDIT `packages/types/src/notification.ts` — `AlertTriggeredData` 추가 (파일 끝)

```ts
// ... 기존 ChatStreamToolParams 뒤 ...

/** notification.alert.triggered params.data — 본문은 evaluator 가 만든 결정적 문자열 그대로 (phase47 M2 불변식). */
export interface AlertTriggeredData {
  readonly alertId: string;
  readonly name: string; // "{SYMBOL} {condition}" (gateway finance.alert.create)
  readonly message: string; // evaluation.message
  readonly currentValue: string;
  readonly triggeredAt: number; // epoch ms
}
```

barrel(`types/src/index.ts`)은 `export type * from './notification.js'` 라 수정 없음.

### M1-2. EDIT `packages/skills-finance/src/alerts/delivery.ts` — websocket 핸들러 복원 (late-bind)

import 추가:

```ts
import type { FinClawLogger } from '@finclaw/infra';
import type { AlertTriggeredData } from '@finclaw/types';
// ... 기존 import ...
```

`// ─── Discord Delivery ───` 블록 뒤, `// ─── Log Delivery ───` 앞에 삽입:

```ts
// ─── WebSocket Delivery (phase47: late-bind — alerts 가 gateway 보다 먼저 생성된다) ───
export function createWebSocketDeliveryHandler(deps: {
  getBroadcast: () => ((data: AlertTriggeredData) => number) | undefined;
}): DeliveryHandler {
  return {
    channel: 'websocket',
    async deliver(alert, evaluation) {
      const broadcast = deps.getBroadcast();
      if (!broadcast) {
        throw new Error('websocket broadcast not bound');
      }
      const sent = broadcast({
        alertId: alert.id,
        name: alert.name,
        message: evaluation.message,
        currentValue: evaluation.currentValue,
        triggeredAt: Date.now(),
      });
      // 받은 연결이 0 이면 실패로 기록 — alert_history 가 "아무도 못 받음" 을 정직하게 남긴다 (Q7)
      if (sent === 0) {
        throw new Error('no websocket subscribers');
      }
    },
  };
}
```

`userId`·`type` 필드는 넣지 않는다(plan M1 구현 노트). `BroadcasterPort` 부활 금지.

### M1-3. EDIT `packages/skills-finance/src/alerts/index.ts` — `setBroadcast` + websocket 핸들러 항상 등록

import:

```ts
import type { AlertTriggeredData } from '@finclaw/types';
// ...
import {
  createDeliveryDispatcher,
  createDiscordDeliveryHandler,
  createLogDeliveryHandler,
  createWebSocketDeliveryHandler,
  type DeliveryHandler,
  type DiscordClientPort,
} from './delivery.js';
```

`AlertSkillHandle`:

```ts
/** Phase 23: RPC 배선에서 alertStore 접근을 위해 monitor 와 store 를 함께 노출 */
export interface AlertSkillHandle {
  readonly monitor: AlertMonitor;
  readonly store: import('./types.js').AlertStore;
  /** phase47: gateway 생성 뒤 main 이 호출 (scheduler setDeliveryHook 과 같은 late-bind — alerts 가 gateway 보다 먼저 생성됨). */
  setBroadcast(fn: (data: AlertTriggeredData) => number): void;
}
```

`registerAlertTools` 안 — 핸들러 배열 교체(before → after):

```ts
// before
const handlers: DeliveryHandler[] = [createLogDeliveryHandler({ logger: config.logger })];

// after
let broadcast: ((data: AlertTriggeredData) => number) | undefined;
const handlers: DeliveryHandler[] = [
  createLogDeliveryHandler({ logger: config.logger }),
  createWebSocketDeliveryHandler({ getBroadcast: () => broadcast }),
];
```

(Discord `if (config.discordClient)` 블록은 그대로.) 반환:

```ts
monitor.start();
return {
  monitor,
  store,
  setBroadcast(fn) {
    broadcast = fn;
  },
};
```

### M1-4. EDIT `packages/gateway/src/ws/connection.ts:47-48` — 기본 구독

```ts
    // Phase 26 E + Phase 28: portfolio.changed / schedule.completed 자동 구독. phase47: alert.triggered.
    subscriptions: new Set(['portfolio.changed', 'schedule.completed', 'alert.triggered']),
```

Web(`app-chat.ts`)·TUI(`App.tsx`) 의 notification 처리는 모르는 method 를 무시한다 — 수정 없음.

### M1-5. EDIT `packages/gateway/src/rpc/methods/finance.ts` — `alertChannels` 주입 + create 기본값

`FinanceRpcDeps` 끝에:

```ts
  /** Phase 26 A: broadcast 대상 WebSocket 연결 맵 (broadcaster 와 함께 주입) */
  readonly connections?: Map<string, WsConnection>;
  /** phase47 D5: create 시 채널 (생략 시 ['log','websocket']). main 이 Discord client + DISCORD_ALERT_USER_ID 일 때만 'discord' 추가 */
  readonly alertChannels?: CreateAlertInput['channels']; // [TQ2] DeliveryChannel 은 패키지 barrel 미export
}
```

`finance.alert.create` 의 `input`(L284):

```ts
        channels: deps.alertChannels ?? ['log', 'websocket'],
```

### M1-6. EDIT `packages/server/src/main.ts` — `setBroadcast` 배선 (`setDeliveryHook(...)` 블록 바로 뒤)

```ts
setDeliveryHook(
  (args) => deliverScheduleResult(),
  // ... 기존 그대로 ...
);
// phase47 M1: 가격 알림 → WS broadcast. setDeliveryHook 과 같은 late-bind (alerts 가 gateway 보다 먼저 생성됨).
alertHandle?.setBroadcast((data) =>
  gateway.ctx.broadcaster.broadcastToChannel(gateway.ctx.connections, 'alert.triggered', data),
);

lifecycle.init();
```

monitor 는 30s 주기(`setInterval`)라 첫 평가 전에 바인딩된다. 그 사이 `evaluateOnce` 가 오지 않는다(gateway 가 아직 RPC 를 받지 않음).

### M1-7. EDIT `packages/skills-finance/src/alerts/__tests__/delivery.test.ts` — websocket 핸들러 4건

import 에 `createWebSocketDeliveryHandler` 추가. 파일 끝에:

```ts
describe('WebSocketDeliveryHandler (phase47)', () => {
  it('바인딩된 broadcast 에 AlertTriggeredData shape 로 호출 (userId·type 없음)', async () => {
    const broadcast = vi.fn().mockReturnValue(1);
    const handler = createWebSocketDeliveryHandler({ getBroadcast: () => broadcast });
    await handler.deliver(mockAlert(), mockEvaluation);
    expect(handler.channel).toBe('websocket');
    expect(broadcast).toHaveBeenCalledWith({
      alertId: 'alert-1',
      name: 'AAPL 가격 알림',
      message: mockEvaluation.message,
      currentValue: '210',
      triggeredAt: expect.any(Number),
    });
  });

  it('받은 연결 0 → reject', async () => {
    const handler = createWebSocketDeliveryHandler({ getBroadcast: () => () => 0 });
    await expect(handler.deliver(mockAlert(), mockEvaluation)).rejects.toThrow(
      'no websocket subscribers',
    );
  });

  it('바인딩 전 → reject', async () => {
    const handler = createWebSocketDeliveryHandler({ getBroadcast: () => undefined });
    await expect(handler.deliver(mockAlert(), mockEvaluation)).rejects.toThrow(
      'websocket broadcast not bound',
    );
  });

  it('dispatcher 결과에 websocket 실패가 success:false 로 남는다 (log 는 성공)', async () => {
    const dispatcher = createDeliveryDispatcher({
      handlers: [
        createLogDeliveryHandler({ logger: mockLogger() }),
        createWebSocketDeliveryHandler({ getBroadcast: () => undefined }),
      ],
      logger: mockLogger(),
    });
    const results = await dispatcher.dispatch(
      mockAlert({ channels: ['log', 'websocket'] }),
      mockEvaluation,
    );
    expect(results.map((r) => [r.channel, r.success])).toEqual([
      ['log', true],
      ['websocket', false],
    ]);
    expect(results[1]?.error).toContain('websocket broadcast not bound');
  });
});
```

### M1-8. EDIT `packages/gateway/src/ws/connection.test.ts` — 기본 구독 1건

`describe('WebSocket Connection')` 안에:

```ts
it('기본 구독에 alert.triggered 포함 (phase47)', async () => {
  const ctx = makeCtx();
  await handleWsConnection(createMockWs() as unknown as import('ws').WebSocket, makeReq(), ctx);
  const conn = [...ctx.connections.values()][0];
  expect([...(conn?.subscriptions ?? [])]).toEqual([
    'portfolio.changed',
    'schedule.completed',
    'alert.triggered',
  ]);
});
```

### M1-9. EDIT `packages/gateway/src/rpc/methods/finance.test.ts` — create 채널 2건

`describe('finance.alert.create')` 안(기존 `makeStore()` 재사용):

```ts
it('기본 channels = [log, websocket] (phase47 D5)', async () => {
  const store = makeStore();
  registerFinanceMethods({ alertStore: store }, methods);
  await call('finance.alert.create', { symbol: 'AAPL', condition: 'price_above', threshold: 200 });
  expect(store.create).toHaveBeenCalledWith(
    expect.objectContaining({ channels: ['log', 'websocket'] }),
  );
});

it('alertChannels 주입 시 그 값', async () => {
  const store = makeStore();
  registerFinanceMethods(
    { alertStore: store, alertChannels: ['log', 'websocket', 'discord'] },
    methods,
  );
  await call('finance.alert.create', { symbol: 'AAPL', condition: 'price_above', threshold: 200 });
  expect(store.create).toHaveBeenCalledWith(
    expect.objectContaining({ channels: ['log', 'websocket', 'discord'] }),
  );
});
```

### M1-10. 밀스톤 M1 검증

```bash
pnpm vitest run packages/skills-finance/src/alerts packages/gateway/src/ws packages/gateway/src/rpc/methods/finance.test.ts
# + §0 서버 게이트 전체
```

기대: unit 1007 → **1014**(+7), storage 141 불변, 실패 0.

---

## 밀스톤 M2 — alert delete · chat.history · 클라이언트 runId

> 커밋: `feat(phase47): add alert delete, chat history and client run ids`

### M2-1. EDIT `packages/types/src/gateway.ts` — `RpcMethod` 2개

```ts
  | 'finance.alert.create'
  | 'finance.alert.list'
  | 'finance.alert.delete'
  // ...
  | 'chat.reset'
  | 'chat.history'
```

### M2-2. EDIT `packages/gateway/src/rpc/methods/finance.ts` — `finance.alert.delete`

`alertListHandler` 정의 뒤에:

```ts
// ── finance.alert.delete ── (phase47: alert_history 도 ON DELETE CASCADE 로 함께 삭제 — storage/database.ts:122)
const alertDeleteHandler: RpcMethodHandler<{ alertId: string }, { deleted: boolean }> = {
  method: 'finance.alert.delete',
  description: '알림을 삭제합니다 (발화 기록 alert_history 도 함께 삭제)',
  authLevel: 'token',
  schema: z.object({ alertId: z.string().min(1) }),
  async execute(params) {
    if (!deps.alertStore) {
      throw new Error('provider_unavailable: alert store not initialized');
    }
    return { deleted: deps.alertStore.delete(params.alertId) };
  },
};
```

등록부:

```ts
registry.register(alertListHandler);
registry.register(alertDeleteHandler);
```

monitor 는 매 tick `store.listEnabled()` 를 읽으므로 삭제가 즉시 반영된다(캐시 없음).

### M2-3. EDIT `packages/gateway/src/rpc/methods/chat.ts` — deps·history·runId

import:

```ts
import type { ModelRef, SessionKey, StorageAdapter } from '@finclaw/types';
```

`ChatMethodsDeps` 끝에:

```ts
  readonly logger?: FinClawLogger;
  /** phase47: chat.history 용 (생략 시 provider_unavailable). */
  readonly storage?: Pick<StorageAdapter, 'getConversation'>;
}
```

`sendHandler` — 타입·스키마·execute 앞부분(before → after):

```ts
  const sendHandler: RpcMethodHandler<
    { sessionId: string; message: string; idempotencyKey?: string; runId?: string },
    { runId: string }
  > = {
    // ... method·description·authLevel 그대로 ...
    schema: z.object({
      sessionId: z.string(),
      // argv 단일 인자 한도(Linux 128KiB) 안쪽: 한글 3B × 20,000 = 60KB + <context>·recap 여유
      message: z.string().min(1).max(20_000),
      idempotencyKey: z.string().optional(),
      // phase47 §2-3: 클라이언트가 runId 를 먼저 정한다 — 응답보다 먼저 온 즉시 실패 이벤트도 짝지을 수 있게
      runId: z.uuid().optional(),
    }),
    async execute(params) {
      const session = deps.registry.getSession(params.sessionId);
      if (!session) {
        throw new Error('session not found');
      }
      const runId = params.runId ?? randomUUID();
      if (activeRuns.has(runId)) {
        throw new Error('duplicate runId');
      }
      const run: ActiveRun = {
        runId,
        sessionId: session.sessionId,
        controller: new AbortController(),
      };
      // ... 이하 기존 그대로 (activeRuns.set / runStarted / void streamRun / return { runId: run.runId }) ...
```

`resetHandler` 뒤에 `historyHandler`:

```ts
// phase47 Q5/U1: 맥 패널 이력. 세션 없음 문구는 send 와 같다 → 클라이언트의 재-start 경로 재사용.
const historyHandler: RpcMethodHandler<
  { sessionId: string; limit?: number },
  { messages: Array<{ role: 'user' | 'assistant'; text: string }> }
> = {
  method: 'chat.history',
  description: '세션 대화의 최근 user/assistant 메시지를 조회합니다',
  authLevel: 'token',
  schema: z.object({
    sessionId: z.string(),
    limit: z.number().int().min(1).max(40).optional(),
  }),
  async execute(params) {
    const session = deps.registry.getSession(params.sessionId);
    if (!session) {
      throw new Error('session not found');
    }
    if (!deps.storage) {
      throw new Error('provider_unavailable: storage not initialized');
    }
    const record = await deps.storage.getConversation(session.sessionKey);
    // ConversationMessage 에 시각 필드가 없다 → {role, text} 만 (plan 머리말 6)
    const messages = (record?.messages ?? []).flatMap((m) =>
      m.role === 'user' || m.role === 'assistant'
        ? [
            {
              role: m.role,
              text:
                typeof m.content === 'string'
                  ? m.content
                  : m.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''),
            },
          ]
        : [],
    );
    return { messages: messages.slice(-(params.limit ?? 20)) };
  },
};

return [startHandler, sendHandler, abortHandler, resetHandler, historyHandler];
```

(`flatMap` 은 TS 버전과 무관하게 판별 유니온을 좁힌다 — `filter` 의 추론 술어에 기대지 않음.)

### M2-4. EDIT `packages/gateway/src/server.ts` — `GatewayServerDeps.storage` + 전달

```ts
  /** Phase 40 A: /mcp 라우트가 in-process 호출할 라이브 ToolRegistry (생략 시 /mcp 비활성). */
  readonly toolRegistry?: import('@finclaw/agent').ToolRegistry;
  /** phase47: chat.history 가 읽는 대화 저장소 (생략 시 chat.history 는 provider_unavailable). */
  readonly storage?: Pick<import('@finclaw/types').StorageAdapter, 'getConversation'>;
}
```

`registerChatMethods({...})` 인자에 `storage: deps.storage,` 한 줄(`logger` 뒤).

### M2-5. EDIT `packages/server/src/main.ts` — gateway deps 에 storage

```ts
  const gateway = createGatewayServer(gatewayConfig, {
    defaultModel: DEFAULT_MODEL,
    runtime,
    storage, // phase47: chat.history
    toolRegistry, // ...
```

### M2-6. EDIT `packages/gateway/src/rpc/methods/finance.test.ts` — delete 4건

`describe('finance.* RPC methods')` 안, `finance.alert.list` describe 뒤:

```ts
describe('finance.alert.delete (phase47)', () => {
  it('있음 → {deleted:true}, store.delete(alertId)', async () => {
    const store = { delete: vi.fn().mockReturnValue(true) } as unknown as AlertStore;
    registerFinanceMethods({ alertStore: store }, methods);
    const res = await call('finance.alert.delete', { alertId: 'a1' });
    expect((res as { result: unknown }).result).toEqual({ deleted: true });
    expect(store.delete).toHaveBeenCalledWith('a1');
  });

  it('없는 id → {deleted:false}', async () => {
    const store = { delete: vi.fn().mockReturnValue(false) } as unknown as AlertStore;
    registerFinanceMethods({ alertStore: store }, methods);
    const res = await call('finance.alert.delete', { alertId: 'nope' });
    expect((res as { result: unknown }).result).toEqual({ deleted: false });
  });

  it('store 없음 → provider_unavailable', async () => {
    registerFinanceMethods({}, methods);
    const res = await call('finance.alert.delete', { alertId: 'a1' });
    expect((res as { error: { message: string } }).error.message).toContain('provider_unavailable');
  });

  it('빈 alertId → INVALID_PARAMS', async () => {
    registerFinanceMethods({ alertStore: {} as AlertStore }, methods);
    const res = await call('finance.alert.delete', { alertId: '' });
    expect((res as { error: { code: number } }).error.code).toBe(RpcErrors.INVALID_PARAMS);
  });
});
```

CASCADE 자체는 기존 스키마 사실이라 여기서 재검증하지 않는다(storage 패키지 소관).

### M2-7. EDIT `packages/gateway/src/rpc/methods/chat.test.ts` — history 9건 · runId 3건

헬퍼 확장(기존 호출부는 인자 2개라 그대로 동작):

```ts
import type { ConversationMessage, ModelRef, RpcMethod } from '@finclaw/types';
import { registerChatMethods, type ChatMethodsDeps } from './chat.js';
// ...
  async function startSession(
    runtime: AgentRunPort,
    conn?: WsConnection,
    storage?: ChatMethodsDeps['storage'],
  ) {
    ctx = makeServerCtx();
    registerChatMethods(
      {
        registry: ctx.registry,
        connections: ctx.connections,
        broadcaster: ctx.broadcaster,
        defaultModel: TEST_MODEL,
        runtime,
        storage,
      },
      ctx.methods,
    );
    // ... 이하 기존 그대로 ...
```

파일 끝(최상위 describe 안):

```ts
const call = (method: string, params: Record<string, unknown>) =>
  dispatchRpc(
    { jsonrpc: '2.0', id: 1, method: method as RpcMethod, params },
    { auth: { level: 'token' }, remoteAddress: '127.0.0.1' },
    ctx,
  );

describe('chat.history (phase47)', () => {
  const storageWith = (messages: ConversationMessage[] | null) =>
    ({
      getConversation: vi.fn().mockResolvedValue(
        messages === null
          ? null
          : {
              sessionKey: 'tui:local:default',
              agentId: 'default',
              messages,
              createdAt: 0,
              updatedAt: 0,
            },
      ),
    }) as unknown as NonNullable<ChatMethodsDeps['storage']>;
  const turns = (n: number): ConversationMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      role: i % 2 === 0 ? ('user' as const) : ('assistant' as const),
      content: `m${i}`,
    }));
  type History = { result: { messages: Array<{ role: string; text: string }> } };

  it('기본 limit 20 — 최근 20개', async () => {
    const sessionId = await startSession(gatedRuntime().runtime, undefined, storageWith(turns(25)));
    const res = (await call('chat.history', { sessionId })) as History;
    expect(res.result.messages).toHaveLength(20);
    expect(res.result.messages.at(-1)).toEqual({ role: 'user', text: 'm24' });
  });

  it('limit 3 → 최근 3개', async () => {
    const sessionId = await startSession(gatedRuntime().runtime, undefined, storageWith(turns(10)));
    const res = (await call('chat.history', { sessionId, limit: 3 })) as History;
    expect(res.result.messages.map((m) => m.text)).toEqual(['m7', 'm8', 'm9']);
  });

  it('블록 content 는 text 블록만 이어 붙인다', async () => {
    const storage = storageWith([
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'a' },
          { type: 'tool_use', id: 't', name: 'x', input: {} },
          { type: 'text', text: 'b' },
        ],
      },
    ]);
    const sessionId = await startSession(gatedRuntime().runtime, undefined, storage);
    const res = (await call('chat.history', { sessionId })) as History;
    expect(res.result.messages).toEqual([{ role: 'assistant', text: 'ab' }]);
  });

  it('system / tool role 은 제외', async () => {
    const storage = storageWith([
      { role: 'system', content: 's' },
      { role: 'user', content: 'q' },
      { role: 'tool', content: 't' },
      { role: 'assistant', content: 'a' },
    ]);
    const sessionId = await startSession(gatedRuntime().runtime, undefined, storage);
    const res = (await call('chat.history', { sessionId })) as History;
    expect(res.result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('세션의 sessionKey 로 조회', async () => {
    const storage = storageWith([]);
    const sessionId = await startSession(gatedRuntime().runtime, undefined, storage);
    await call('chat.history', { sessionId });
    expect(storage.getConversation).toHaveBeenCalledWith('tui:local:default');
  });

  it('대화 기록 없음 → 빈 배열', async () => {
    const sessionId = await startSession(gatedRuntime().runtime, undefined, storageWith(null));
    const res = (await call('chat.history', { sessionId })) as History;
    expect(res.result.messages).toEqual([]);
  });

  it('없는 세션 → session not found', async () => {
    await startSession(gatedRuntime().runtime, undefined, storageWith([]));
    const res = (await call('chat.history', { sessionId: 'nope' })) as {
      error: { message: string };
    };
    expect(res.error.message).toBe('session not found');
  });

  it('storage 없음 → provider_unavailable', async () => {
    const sessionId = await startSession(gatedRuntime().runtime);
    const res = (await call('chat.history', { sessionId })) as { error: { message: string } };
    expect(res.error.message).toContain('provider_unavailable');
  });

  it('limit 0 · 41 → INVALID_PARAMS', async () => {
    const sessionId = await startSession(gatedRuntime().runtime, undefined, storageWith([]));
    for (const limit of [0, 41]) {
      const res = (await call('chat.history', { sessionId, limit })) as { error: { code: number } };
      expect(res.error.code).toBe(RpcErrors.INVALID_PARAMS);
    }
  });
});

describe('chat.send runId (phase47)', () => {
  const RUN = '3f2b8c1e-9a4d-4c7e-8b1a-2d6e5f7a9c0b'; // v4 UUID

  it('runId 지정 → 응답·runtime·스트림이 그 값', async () => {
    const g = gatedRuntime();
    const conn = mockConn();
    const sessionId = await startSession(g.runtime, conn);
    const res = (await call('chat.send', { sessionId, message: '안녕', runId: RUN })) as {
      result: { runId: string };
    };
    expect(res.result.runId).toBe(RUN);
    expect(g.calls[0]?.runId).toBe(RUN);
    g.open();
    await vi.waitFor(() => expect(conn.sent.map((m) => m.method)).toContain('chat.stream.end'));
    expect(conn.sent.every((m) => m.params.runId === RUN)).toBe(true);
  });

  it('진행 중 같은 runId → duplicate runId', async () => {
    const g = gatedRuntime();
    const sessionId = await startSession(g.runtime, mockConn());
    await call('chat.send', { sessionId, message: '1', runId: RUN });
    const dup = (await call('chat.send', { sessionId, message: '2', runId: RUN })) as {
      error: { message: string };
    };
    expect(dup.error.message).toBe('duplicate runId');
    g.open();
  });

  it('비-UUID runId → INVALID_PARAMS', async () => {
    const sessionId = await startSession(gatedRuntime().runtime, mockConn());
    const res = (await call('chat.send', { sessionId, message: 'x', runId: 'abc' })) as {
      error: { code: number };
    };
    expect(res.error.code).toBe(RpcErrors.INVALID_PARAMS);
  });
});
```

(`call` 이름이 파일 안 다른 지역 헬퍼와 겹치면 `rpcCall` 로. 생략 시 서버 발급 runId 는 기존 `'run 종료 전에 {runId} 를 즉시 돌려준다'` 가 덮는다.)

### M2-8. 밀스톤 M2 검증

```bash
pnpm vitest run packages/gateway/src/rpc/methods/finance.test.ts packages/gateway/src/rpc/methods/chat.test.ts
# + §0 서버 게이트 전체
```

기대: unit 1014 → **1030**(+16), 실패 0.

---

## 밀스톤 M3 — Discord 알림 DM 수신자 (Q6, 결함 수정 단독 커밋)

> 커밋: `fix(phase47): deliver Discord alert DMs to the configured user`

### M3-1. EDIT `packages/skills-finance/src/alerts/delivery.ts` — Discord 핸들러 `userId?`

```ts
// ─── Discord Delivery ───
export function createDiscordDeliveryHandler(deps: {
  client: DiscordClientPort;
  /** phase47 Q6: DISCORD_ALERT_USER_ID. RPC 로 만든 알림의 userId 는 'default' 라 DM 대상이 될 수 없다. */
  userId?: string;
}): DeliveryHandler {
  return {
    channel: 'discord',
    async deliver(alert, evaluation) {
      const user = await deps.client.users.fetch(deps.userId ?? alert.userId);
      // ... 이하 그대로 ...
```

### M3-2. EDIT `packages/skills-finance/src/alerts/index.ts` — config 전달

```ts
export interface AlertSkillConfig {
  // ... 기존 ...
  readonly discordClient?: DiscordClientPort;
  /** phase47 Q6: Discord DM 수신자 (DISCORD_ALERT_USER_ID). */
  readonly discordUserId?: string;
  readonly monitorConfig?: Partial<AlertMonitorConfig>;
}
// ...
if (config.discordClient) {
  handlers.push(
    createDiscordDeliveryHandler({ client: config.discordClient, userId: config.discordUserId }),
  );
}
```

### M3-3. EDIT `packages/server/src/composition/skills.ts` — `RegisterSkillsDeps.discordAlertUserId?`

```ts
  readonly discordClient?: NonNullable<ReturnType<DiscordAdapter['getClient']>>;
  /** phase47 Q6: 가격·뉴스 알림 Discord DM 수신자 (main 이 DISCORD_ALERT_USER_ID 를 1회 읽어 전달). */
  readonly discordAlertUserId?: string;
```

`registerAlertTools(toolRegistry, {...})` 인자에 `discordUserId: deps.discordAlertUserId,` (`discordClient,` 다음 줄). 구조분해 줄은 건드리지 않는다.

### M3-4. EDIT `packages/server/src/main.ts` — env 1회 읽기 → skills + alertChannels

`setupDiscord(...)` 바로 뒤:

```ts
const discordAdapter = await setupDiscord(process.env.DISCORD_BOT_TOKEN, { logger, lifecycle });
// phase47 Q6/D5: 알림 DM 수신자 — skills(Discord 핸들러)와 financeDeps(새 알림 기본 채널)가 같은 값을 쓴다 (env 읽기 1곳)
const discordAlertUserId = process.env.DISCORD_ALERT_USER_ID || undefined;
```

`registerSkills({...})` 에 `discordAlertUserId,` (`discordClient` 다음). `financeDeps` 에:

```ts
      // phase47 D5: Discord client 와 수신자 id 가 둘 다 있을 때만 새 알림에 'discord'
      alertChannels: discordAdapter && discordAlertUserId ? ['log', 'websocket', 'discord'] : undefined,
```

(객체 리터럴 안이라 `FinanceRpcDeps` 로 문맥 타입이 잡혀 리터럴이 좁혀진다.) 스케줄 Discord 전달(`deliveryTarget`)은 건드리지 않는다.

### M3-5. EDIT `.env.example` — `DISCORD_BOT_TOKEN=` 바로 아래

```bash
# 가격·뉴스 알림 Discord DM 수신자(Discord 사용자 id). DISCORD_BOT_TOKEN 과 함께 있을 때만 새 알림에 discord 채널이 붙는다. 설정하면 예전 ['log','discord'] 알림도 이 id 로 DM 된다.
DISCORD_ALERT_USER_ID=
```

### M3-6. EDIT `packages/skills-finance/src/alerts/__tests__/delivery.test.ts` — Discord 1건 추가

기존 `'user.createDM() → send() 호출'` 이 "userId 없음 → alert.userId" 를 이미 단언한다(`fetch('user-1')`). 추가:

```ts
it('userId 주입 시 alert.userId 대신 그 값으로 fetch (phase47 Q6)', async () => {
  const send = vi.fn().mockResolvedValue(undefined);
  const createDM = vi.fn().mockResolvedValue({ send });
  const fetch = vi.fn().mockResolvedValue({ createDM });
  const handler = createDiscordDeliveryHandler({
    client: { users: { fetch } },
    userId: '123456789',
  });
  await handler.deliver(mockAlert(), mockEvaluation);
  expect(fetch).toHaveBeenCalledWith('123456789');
});
```

### M3-7. 밀스톤 M3 검증

`pnpm vitest run packages/skills-finance/src/alerts` + §0 서버 게이트. 기대 unit **1031**(+1).

---

## 밀스톤 M4 — 페르소나 "핀"

> 커밋: `feat(phase47): give the assistant the Pin persona`

### M4-1. EDIT `packages/server/prompts/finclaw.system.ko.md` — 원칙 7 뒤, `## 작업 위임` 앞

현재 L22 = 원칙 7, L23 = 빈 줄, L24 = `## 작업 위임 — \`route_task\``. L23 빈 줄 뒤에 **plan §4-7 의 마크다운 블록 전문을 한 글자도 바꾸지 않고** 붙이고, 블록 끝에 빈 줄 1개를 둬 L24 헤딩과 분리한다. frontmatter·첫 줄 정체성 문장·다른 섹션은 그대로. `\*\*/prompts/` 는 oxfmt 무시 대상.

### M4-2. EDIT `packages/server/src/prompts/__tests__/identity.test.ts` — 키워드 2개

```ts
      '## 도구 결과 처리',
      'market_analysis',
      '## 캐릭터 — 핀',
      '해요체',
    ]) {
```

### M4-3. 밀스톤 M4 검증

`pnpm vitest run packages/server/src/prompts` + §0 서버 게이트. 테스트 수 불변(같은 it 안 키워드 추가). 실제 말투는 M5 스모크 S2(키 없으면 S1 의 답)에서 reset 뒤 확인 — CLI 가 세션 첫 요청에 프롬프트를 snapshot 하므로 스모크 전 `chat.reset` 1회(R10 관례).

---

## 밀스톤 M5 — 맥 패키지 · gateway 클라이언트 · 헤드리스 스모크 · CI

> 커밋: `feat(phase47): add mac app package with gateway client`
> 이 밀스톤의 `App.swift` 는 `Entry` 만(`--smoke` 면 스모크, 아니면 사용법 출력 후 exit 64). GUI 는 M7.

### M5-1. EDIT `.gitignore` — Swift 산출물 (D8, [TQ5])

`# Coverage` 블록 앞에:

```gitignore
# Swift (apps/mac) — 번들 출력 apps/mac/dist/ 는 위 dist/ 규칙으로 무시
apps/mac/.build/
apps/mac/.swiftpm/
```

`.oxfmtrc.json`·`oxlintrc.json` 은 **수정하지 않는다** — oxfmt 0.46 은 `.gitignore` 를 기본으로 따른다 [TQ5]. M5-12 에서 `.build/` 가 생긴 상태로 `pnpm format && pnpm lint` 가 통과하는지 확인하고, 실패할 때만 `.oxfmtrc.json` `ignorePatterns` 에 `"apps/mac/.build/"` 를 추가한다.

### M5-2. CREATE `apps/mac/Package.swift`

plan §3-1 그대로:

```swift
// swift-tools-version: 6.0
import PackageDescription

let package = Package(
  name: "FinClawMac",
  platforms: [.macOS(.v14)],
  targets: [
    .target(name: "FinClawMacCore"),
    .executableTarget(name: "FinClawMac", dependencies: ["FinClawMacCore"]),
    .testTarget(
      name: "FinClawMacCoreTests", dependencies: ["FinClawMacCore"],
      resources: [.copy("Fixtures")]),
  ]
)
```

픽스처 접근: `Bundle.module.url(forResource: "frames", withExtension: "jsonl", subdirectory: "Fixtures")`.

### M5-3. CREATE `apps/mac/Sources/FinClawMacCore/Protocol.swift` (예산 100)

- **책임:** 요청 인코드 · 수신 텍스트 프레임 두 단계 디코드 · 페이로드 타입. Foundation 만.
- **공개 API:** plan §3-2 `RpcError`·`ToolPhase`·`AlertTriggered`·`ScheduleCompleted`·`ServerEvent`·`Frame`·`decodeFrame(_:)`·`encodeRequest(id:method:params:)` 그대로. 추가 공개: `public struct Reply<R: Decodable>: Decodable { public let result: R }`(GatewayClient 가 응답 디코드에 씀), `public struct StartResult: Decodable { public let sessionId: String }`, `public struct RunIdResult: Decodable { public let runId: String }`.
- **틀리기 쉬운 곳 — 이중 디코딩:** 응답의 `result` 원문만 떼어 내는 API 가 JSONDecoder 에 없다. → `Frame.response` 의 `Data` 는 **프레임 전체 바이트**이고, 호출자가 `Reply<R>` 로 다시 디코드한다. notification 은 method 별 `Params<P>` 로 다시 디코드.

```swift
private struct Envelope: Decodable { let id: Int?; let method: String?; let error: RpcError? }
private struct Params<P: Decodable>: Decodable { let params: P }
private struct Wrapped<T: Decodable>: Decodable { let data: T }          // notification.* 의 params.data
private struct DeltaP: Decodable { let runId: String; let delta: String }
private struct ToolP: Decodable { let runId, toolCallId, name: String; let phase: ToolPhase; let isError: Bool? }
private struct EndP: Decodable { let runId: String; let result: Text; struct Text: Decodable { let text: String } }
private struct ErrP: Decodable { let runId: String; let reason: String }

public func decodeFrame(_ text: String) -> Frame? {
  let data = Data(text.utf8)
  let dec = JSONDecoder()
  guard let env = try? dec.decode(Envelope.self, from: data) else { return nil }
  if let id = env.id {                                    // id:null(파스 에러)은 nil 로 떨어져 아래 default → nil
    return .response(id: id, result: env.error.map { .failure($0) } ?? .success(data))
  }
  func p<P: Decodable>(_: P.Type) -> P? { try? dec.decode(Params<P>.self, from: data).params }
  switch env.method {
  case "chat.stream.delta": return p(DeltaP.self).map { .event(.delta(runId: $0.runId, text: $0.delta)) }
  case "chat.stream.tool":
    return p(ToolP.self).map { .event(.tool(runId: $0.runId, toolCallId: $0.toolCallId, name: $0.name,
                                            phase: $0.phase, isError: $0.isError ?? false)) }
  case "chat.stream.end": return p(EndP.self).map { .event(.end(runId: $0.runId, text: $0.result.text)) }
  case "chat.stream.error": return p(ErrP.self).map { .event(.runError(runId: $0.runId, reason: $0.reason)) }
  case "notification.alert.triggered": return p(Wrapped<AlertTriggered>.self).map { .event(.alertTriggered($0.data)) }
  case "notification.schedule.completed": return p(Wrapped<ScheduleCompleted>.self).map { .event(.scheduleCompleted($0.data)) }
  case "system.shutdown": return .event(.shutdown)
  default: return nil                                      // notification.portfolio.changed 등 — 무시
  }
}

private struct Req<P: Encodable>: Encodable { var jsonrpc = "2.0"; let id: Int; let method: String; let params: P }
public func encodeRequest(id: Int, method: String, params: some Encodable) throws -> String {
  String(decoding: try JSONEncoder().encode(Req(id: id, method: method, params: params)), as: UTF8.self)
}
```

- `ScheduleCompleted.error` 는 서버가 `undefined` 면 키 자체가 없다 → `String?` 로 충분. `runId` 는 `null` 가능.

### M5-4. CREATE `apps/mac/Sources/FinClawMacCore/Connection.swift` (예산 45 → ~50 [TQ3])

- **책임:** 전송 seam(프로토콜) + 실 구현 1(URLSession 래퍼) + 토큰 읽기.
- **공개 API:** plan §3-2 `WebSocketConnection`·`readToken(at:)` 그대로 + `URLSessionConnection` [TQ3].

```swift
public protocol WebSocketConnection: AnyObject, Sendable {
  func resume()
  func send(_ text: String) async throws
  func receive() async throws -> String                 // 텍스트 프레임만. binary 는 throw
  func sendPing() async throws
  func cancel()
  var closeCode: Int { get }                            // G9
}

/// [TQ3] URLSessionWebSocketTask 를 직접 적합시키면 closeCode(타입 다름)·receive()(반환형 오버로드)가 충돌한다 → 래퍼.
public final class URLSessionConnection: WebSocketConnection, @unchecked Sendable {
  private let task: URLSessionWebSocketTask
  public init(_ task: URLSessionWebSocketTask) {
    self.task = task
    task.maximumMessageSize = 8 << 20                   // [TQ3] 기본 1MB — chat.history{limit:40} 대비
  }
  public func resume() { task.resume() }
  public func send(_ text: String) async throws { try await task.send(.string(text)) }
  public func receive() async throws -> String {
    guard case .string(let s) = try await task.receive() else { throw URLError(.cannotDecodeContentData) }
    return s
  }
  public func sendPing() async throws {
    try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
      task.sendPing { err in if let err { c.resume(throwing: err) } else { c.resume() } }
    }
  }
  public func cancel() { task.cancel(with: .goingAway, reason: nil) }
  public var closeCode: Int { task.closeCode.rawValue }
}

public func readToken(at url: URL) -> String? {
  guard let raw = try? String(contentsOf: url, encoding: .utf8) else { return nil }
  let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
  return t.isEmpty ? nil : t
}
```

### M5-5. CREATE `apps/mac/Sources/FinClawMacCore/GatewayClient.swift` (예산 175) — ★최위험

- **책임:** `@MainActor final class` — 접속 루프(토큰 재읽기·헤더 인증·`chat.start` = 온라인), 수신 루프, id 매칭 pending, 30s 타임아웃, ping 25s, 백오프, `session not found` → 재-start + 1회 재전송.
- **공개 API:** plan §3-2 `OfflineReason`·`ClientEvent`·`backoffDelay(attempt:)`·`GatewayClient`(init·`sessionId`·`start`·`reconnect`·`call`·`send(_:runId:)`·`abort(runId:)`·`reset()`) 그대로. 단 init 의 기본 `connect` 는 `{ URLSessionConnection(URLSession.shared.webSocketTask(with: $0)) }` [TQ3].
- **규칙(plan §3-2 구현 노트 전부):** `.connected` 는 `chat.start` 응답 뒤에만 · 토큰 파일 없으면 접속하지 않고 `.disconnected(.noToken)` · 토큰을 로그·`print`·에러 문자열에 넣지 않음 · pending 은 **먼저 꺼내고** resume · 끊기면 남은 pending 전부 `RpcError(code: -1, message: "disconnected")` · close 분류 4001 → `.badToken`(다음 지연 = 최대 15s) / shutdown 수신 뒤 → `.shutdown` / 그 외 `.serverDown` · sessionId 로 이벤트를 거르지 않음.

핵심 로직 스케치:

```swift
public func backoffDelay(attempt: Int) -> Duration {
  .milliseconds(Int(min(800 * pow(1.7, Double(attempt)), 15_000)))   // 0.8, 1.36, 2.312, 3.93, … ≤ 15
}

// start(): loopTask = Task { await runLoop() }.  reconnect(): loopTask?.cancel(); conn?.cancel(); attempt = 0; start()
private func runLoop() async {
  var attempt = 0
  while !Task.isCancelled {
    onEvent(.connecting)
    let (reason, wasOnline) = await connectOnce()
    onEvent(.disconnected(reason))
    if wasOnline { attempt = 0 }                                    // chat.start 성공 시 백오프 초기화
    let delay = reason == .badToken ? .seconds(15) : backoffDelay(attempt: attempt)
    attempt += 1
    try? await sleep(delay)
  }
}

private func connectOnce() async -> (OfflineReason, Bool) {
  guard let token = readToken(at: tokenURL) else { return (.noToken, false) }   // 접속 시도 없음
  var req = URLRequest(url: url)
  req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")        // G6. URL 쿼리 금지 (M8)
  let c = connect(req); conn = c; sawShutdown = false; c.resume()
  let reader = Task { await receiveLoop(c) }                                   // 끝나면 = 끊김
  var online = false
  do {
    sessionId = try await call("chat.start", ["agentId": "default"], as: StartResult.self).sessionId
    online = true; onEvent(.connected)
  } catch { c.cancel() }
  let pinger = Task {                                                          // 서버 사망 감지용 (G7 과 별개)
    while !Task.isCancelled { try? await sleep(.seconds(25)); if (try? await c.sendPing()) == nil { c.cancel() } }
  }
  await reader.value
  pinger.cancel()
  conn = nil; sessionId = nil
  for (_, cont) in pending { cont.resume(throwing: RpcError(code: -1, message: "disconnected")) }
  pending.removeAll()
  let reason: OfflineReason = c.closeCode == 4001 ? .badToken : (sawShutdown ? .shutdown : .serverDown)  // G9
  return (reason, online)
}

private func receiveLoop(_ c: WebSocketConnection) async {
  while let text = try? await c.receive() {
    switch decodeFrame(text) {
    case .response(let id, let result)?:
      pending.removeValue(forKey: id)?.resume(with: result.mapError { $0 as Error })   // 먼저 꺼내고 resume
    case .event(let ev)?:
      if ev == .shutdown { sawShutdown = true }
      onEvent(.server(ev))
    case nil: continue
    }
  }
}

public func call<R: Decodable>(_ method: String, _ params: some Encodable, as: R.Type) async throws -> R {
  guard let c = conn else { throw RpcError(code: -1, message: "disconnected") }
  nextId += 1; let id = nextId
  let text = try encodeRequest(id: id, method: method, params: params)
  let frame: Data = try await withCheckedThrowingContinuation { cont in
    pending[id] = cont
    Task {
      do { try await c.send(text) } catch { pending.removeValue(forKey: id)?.resume(throwing: error) }
    }
    Task {
      try? await sleep(requestTimeout)
      pending.removeValue(forKey: id)?.resume(throwing: RpcError(code: -2, message: "timeout"))
    }
  }
  return try JSONDecoder().decode(Reply<R>.self, from: frame).result
}

public func send(_ message: String, runId: String) async throws {
  for attempt in 0..<2 {
    guard let sid = sessionId else { throw RpcError(code: -1, message: "disconnected") }
    do {
      _ = try await call("chat.send", ["sessionId": sid, "message": message, "runId": runId], as: RunIdResult.self)
      return
    } catch let e as RpcError where attempt == 0 && e.message.contains("session not found") {   // Q9
      sessionId = try await call("chat.start", ["agentId": "default"], as: StartResult.self).sessionId
    }
  }
}
// abort(runId:) → chat.abort {sessionId, runId} · reset() → chat.reset {sessionId}. 응답 타입은 작은 private struct.
```

- `sendPing` 실패 판정은 위처럼 Optional 비교 대신 do/catch 로 써도 된다(가독성 우선).
- 30s 타임아웃 Task 는 응답이 와도 남지만, 깨어난 뒤 `pending` 에 id 가 없으면 아무 일도 안 한다(취소 불필요).

### M5-6. CREATE `apps/mac/Sources/FinClawMac/App.swift` — `Entry` 만 (이 밀스톤 ~18줄)

```swift
import FinClawMacCore
import Foundation

@main enum Entry {
  static func main() {
    let args = CommandLine.arguments
    if let i = args.firstIndex(of: "--smoke"), i + 1 < args.count {
      let listen = args.firstIndex(of: "--listen").flatMap { $0 + 1 < args.count ? Double(args[$0 + 1]) : nil } ?? 0
      setvbuf(stdout, nil, _IOLBF, 0)                     // 파이프로 볼 때 줄 단위 출력 (--listen 중 실시간 확인)
      Task { @MainActor in exit(await Smoke.run(question: args[i + 1], listen: listen)) }
      dispatchMain()
    }
    // M7: --snapshot 분기 + FinClawMacApp.main()
    FileHandle.standardError.write(Data("usage: FinClawMac --smoke \"<질문>\" [--listen <초>]\n".utf8))
    exit(64)
  }
}
```

### M5-7. CREATE `apps/mac/Sources/FinClawMac/Smoke.swift` (예산 35 → ~40)

- **책임:** plan §8-2 헤드리스 스모크. 화면·`NSApplication` 없음. 토큰·sessionId 미출력.
- **접속 대상(D1):** `UserDefaults.standard.string(forKey: "gatewayURL") ?? "ws://127.0.0.1:3000/"`, `tokenPath` 기본 `~/.finclaw/gateway.token`(`NSString.expandingTildeInPath`). 인자 도메인이라 `-gatewayURL`·`-tokenPath` 가 그대로 먹는다. 이 두 줄은 M7 `AppModel` 과 공유하도록 Core 가 아닌 Mac 타깃 안 작은 `enum Settings { static var gatewayURL: URL; static var tokenURL: URL }` 로 둔다(App.swift 아래, ~6줄).
- **출력 형식·종료 코드:** plan §8-2 그대로(`connecting <url>` · `connected` · `sent run=<uuid>` · `tool start <짧은 이름>` · `tool end <짧은 이름> error=<bool>` · `delta x<N> chars=<M>` · `end chars=<M> text="<앞 120자>"` · `event alert.triggered alertId=<id> title="<Copy.alertTitle>"` · `event schedule.completed scheduleId=<id> error=<bool>` · `offline <reason>`). 0 = end(+listen 경과) · 1 = run error(`reason=`) · 2 = 10s 안에 온라인 못 됨(마지막 `offline <reason>`) · 3 = 330s 안에 end/error 없음.
- `tool` 이름은 마지막 `__` 뒤(M6 `Copy` 가 생기기 전이므로 여기서 `split(separator:"__").last`). `title=` 은 M6 이후 `Copy.alertTitle` 로 바꾼다(M8-4 에서 1줄 수정).

```swift
@MainActor enum Smoke {
  static func run(question: String, listen: Double) async -> Int32 {
    var online = false, lastOffline: OfflineReason = .serverDown, deltas = 0, chars = 0
    let runId = UUID().uuidString.lowercased()
    let (stream, cont) = AsyncStream<ClientEvent>.makeStream()
    let client = GatewayClient(url: Settings.gatewayURL, tokenURL: Settings.tokenURL) { cont.yield($0) }
    print("connecting \(Settings.gatewayURL.absoluteString)")
    Task { try? await Task.sleep(for: .seconds(10)); if !online { print("offline \(lastOffline)"); exit(2) } }
    Task { try? await Task.sleep(for: .seconds(330)); print("timeout"); exit(3) }
    client.start()
    for await ev in stream {
      switch ev {
      case .connected where !online:
        online = true; print("connected"); print("sent run=\(runId)")
        Task { do { try await client.send(question, runId: runId) } catch { print("send failed"); exit(1) } }
      case .disconnected(let r): lastOffline = r; if online { print("offline \(r)") }
      case .server(.delta(runId, let t)): deltas += 1; chars += t.count
      case .server(.end(runId, let text)):
        print("delta x\(deltas) chars=\(chars)"); print("end chars=\(text.count) text=\"\(text.prefix(120))\"")
        if listen > 0 { Task { try? await Task.sleep(for: .seconds(listen)); exit(0) } } else { return 0 }
      case .server(.runError(runId, let reason)): print("reason=\(reason)"); return 1
      // tool / alertTriggered / scheduleCompleted 는 위 형식대로 print
      default: break
      }
    }
    return 0
  }
}
```

(`case .server(.delta(runId, let t))` 처럼 지역 상수와 매칭하는 패턴은 Swift 가 `~=` 로 비교한다 — 컴파일 안 되면 `where id == runId`.)

### M5-8. CREATE `apps/mac/Tests/FinClawMacCoreTests/Fixtures/frames.jsonl`

M0 정제본(`_workspace/phase47/frames.jsonl`) 11줄 + 합성 1줄 [TQ6]. 합성 줄은 M1-2 핸들러 shape 를 `broadcastToChannel` 포장 그대로 감싼다:

```json
{
  "name": "notification.alert.triggered",
  "source": "synthetic:m1-shape",
  "raw": "{\"jsonrpc\":\"2.0\",\"method\":\"notification.alert.triggered\",\"params\":{\"data\":{\"alertId\":\"alert-1\",\"name\":\"AAPL price_above\",\"message\":\"AAPL 현재가 210이(가) 목표가 200 이상 조건을 충족했습니다.\",\"currentValue\":\"210\",\"triggeredAt\":1764150000000},\"timestamp\":1764150000001}}"
}
```

커밋 전 M0-3 grep 5종을 이 파일에 다시 돌려 0건 확인.

### M5-9. CREATE `apps/mac/Tests/FinClawMacCoreTests/ProtocolTests.swift`

`import Testing` + `@testable import FinClawMacCore`. 픽스처는 name → raw 맵으로 로드하는 헬퍼 1개.

| 케이스                   | Given / Then                                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `everyFixtureDecodes`    | 모든 픽스처 줄 / `decodeFrame(raw) != nil`                                                                                         |
| `startResult`            | `chat.start.result` / `.response(id, .success)` 이고 `Reply<StartResult>` 의 sessionId 비어 있지 않음                              |
| `sendResult`             | `chat.send.result` / `Reply<RunIdResult>.runId` 가 UUID 형식                                                                       |
| `delta`                  | `chat.stream.delta` / `.delta(runId, text)` · text 비어 있지 않음                                                                  |
| `toolStartEnd`           | `chat.stream.tool.start`·`.end` / phase start·end, name 이 `mcp__finclaw__` 로 시작, end 의 isError == false                       |
| `end`                    | `chat.stream.end` / `.end(runId, text)` 의 text == 원문 `params.result.text`                                                       |
| `abortedError`           | `chat.stream.error.aborted` / `.runError(_, "aborted")`                                                                            |
| `sessionNotFound`        | `error.session-not-found` / `.failure(RpcError(-32603, "session not found"))`                                                      |
| `unauthorized`           | `error.unauthorized` / `.failure` 의 code == -32001                                                                                |
| `scheduleCompleted`      | `notification.schedule.completed` / scheduleId·name·output 채워짐, error == nil                                                    |
| `shutdown`               | `system.shutdown` / `.event(.shutdown)`                                                                                            |
| `alertTriggered`         | 합성 줄 / `.alertTriggered` 의 alertId "alert-1", name "AAPL price_above"                                                          |
| `unknownMethodIsNil`     | `{"jsonrpc":"2.0","method":"notification.portfolio.changed","params":{"data":{},"timestamp":0}}` / nil                             |
| `nullIdParseErrorIsNil`  | `{"jsonrpc":"2.0","id":null,"error":{"code":-32700,"message":"Parse error"}}` / nil                                                |
| `encodeRequestRoundTrip` | `encodeRequest(id: 7, method: "chat.send", params: ["a":"b"])` / JSONSerialization 으로 읽어 jsonrpc "2.0"·id 7·method·params 일치 |

### M5-10. CREATE `apps/mac/Tests/FinClawMacCoreTests/GatewayClientTests.swift` (+ 테스트 헬퍼)

**헬퍼(같은 파일, 예산 밖):**

- `FakeConnection: WebSocketConnection, @unchecked Sendable` — `sent: [String]`, `AsyncThrowingStream<String, Error>` 수신 큐(`push(_ text)`, `close(code: Int)` = closeCode 설정 후 스트림을 에러로 종료), `resume()`·`cancel()` 기록. `autoStart: Bool` 이면 `chat.start` 요청을 보면 `{"jsonrpc":"2.0","id":<그 id>,"result":{"sessionId":"s1"}}` 를 자동 push.
- `TestClock` — **가상 시간**. `sleep(d)` = deadline(now + d) 을 등록하고 continuation 으로 대기, `advance(by:)` 가 now 를 옮기고 deadline ≤ now 인 것만 resume, `delays: [Duration]` 기록, 테스트 끝에 `drain()` 으로 남은 대기를 `CancellationError` 로 끝낸다(continuation 누수 경고 방지). **즉시 반환 sleep 을 쓰지 말 것** — 30s 타임아웃이 바로 터지고 재접속 루프가 무한히 돈다.
- 토큰은 임시 디렉터리 파일(`FileManager.default.temporaryDirectory`), 실 네트워크 없음(M6 불변식).
- 테스트는 `@MainActor @Test`.

| 케이스                        | Given / Then                                                                                                       |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `bearerHeaderFromTokenFile`   | 토큰 파일 "tok" / connect 에 넘어온 URLRequest 의 `Authorization == "Bearer tok"`, `url.query == nil`              |
| `noTokenSkipsConnect`         | 토큰 파일 없음 / connect 호출 0, 이벤트 `[.connecting, .disconnected(.noToken)]`                                   |
| `connectedOnlyAfterChatStart` | autoStart off, open 만 / `.connected` 없음 → start 응답 push 뒤 `.connected`, `sessionId == "s1"`                  |
| `matchesResponsesById`        | call 2개 진행 중, 응답을 역순 push / 각자 자기 결과                                                                |
| `requestTimesOut`             | 응답 없음, `clock.advance(by: .seconds(30))` / `RpcError.code == -2`, pending 비움                                 |
| `disconnectFailsPending`      | call 진행 중 `close(code: 1006)` / call 이 `code -1 "disconnected"` 로 throw                                       |
| `close4001IsBadToken`         | close 4001 / `.disconnected(.badToken)`, 다음 `clock.delays.last == .seconds(15)`                                  |
| `shutdownThenCloseIsShutdown` | `system.shutdown` push 뒤 close 1000 / `.server(.shutdown)` 후 `.disconnected(.shutdown)`                          |
| `otherCloseIsServerDown`      | close 1006 / `.disconnected(.serverDown)`                                                                          |
| `sendCarriesRunId`            | 온라인, `send("hi", runId: "r1")` / 보낸 프레임 params == `{sessionId:"s1", message:"hi", runId:"r1"}`             |
| `sessionNotFoundRestartsOnce` | 첫 chat.send 에 -32603 "session not found" / 다음 프레임 chat.start → 새 sessionId 로 같은 runId 재전송, send 성공 |
| `secondSessionNotFoundThrows` | 두 번 다 session not found / send 가 throw, chat.send 는 정확히 2회                                                |
| `backoffSequence`             | `backoffDelay(0…10)` / 0.8, 1.36, 2.312, 3.9304… 단조 증가, `backoffDelay(10) == .seconds(15)`                     |
| `backoffResetsAfterOnline`    | 실패 2회(지연 0.8·1.36) → 온라인 → 끊김 / 다음 지연 0.8                                                            |
| `rereadsTokenEachAttempt`     | 1차 "a" 로 실패 → 파일을 "b" 로 교체 → advance / 2차 요청 헤더 "Bearer b"                                          |

### M5-11. CREATE `.github/workflows/mac.yml`

plan M5 의 YAML 그대로(경로 필터 `apps/mac/**`·`.github/workflows/mac.yml`, `macos-latest`, `timeout-minutes: 15`, `actions/checkout@v6`, `swift --version` → `swift build --package-path apps/mac` → `swift test --package-path apps/mac`). oxfmt 가 yml 을 검사하면 `pnpm format:fix` 로 정리.

### M5-12. 밀스톤 M5 검증

**자동(에이전트):**

```bash
cd apps/mac && swift build -c release 2>&1 | tail -3 && swift test 2>&1 | tail -5; cd -   # 경고 0, Protocol 15 + Client 15
pnpm format && pnpm lint                         # .build/ 가 있는 상태로 통과 [TQ5]
find apps/mac/Sources -name '*.swift' -exec cat {} + | grep -cv '^[[:space:]]*$'          # ~385 기록
```

**실 서버 스모크(에이전트)** — M0-1 처럼 서버 기동(이제 M1~M4 코드 포함), 스모크 전 `chat.reset` 1회(M4 프롬프트 반영 — 스모크 질문이 `tui:local:default` 에 남는다, R10). `EXE=apps/mac/.build/release/FinClawMac`(포트가 3000 이 아니면 `-gatewayURL ws://127.0.0.1:$PORT/` 추가):

| #   | 명령                                                                        | 기대                                             | 판정 → no-go 폴백                                                                                                     |
| --- | --------------------------------------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| S1  | `$EXE --smoke "지금 몇 시인지 한 줄로 알려줘"`                              | `connected` → `end`, exit 0, 답이 해요체         | **G6** 헤더 인증 → no-go: `?token=` 쿼리로 바꾸고 서버 access log(`access_log` 테이블·stdout)에 토큰이 안 남는지 확인 |
| S2  | `$EXE --smoke "애플 주가 알려줘"`                                           | `tool start route_task`/`tool end`               | 키 없음 → **미실행 기록** [TQ6]                                                                                       |
| S3  | `$EXE --smoke "안녕" --listen 100`                                          | end 뒤 100s 동안 `offline` 줄 없음, exit 0       | **G7** 자동 pong → no-go: 25s 주기 `system.ping` RPC 로 대체(pinger 의 `sendPing` 자리)                               |
| S4  | `echo bogus > $SCR/fake.token && $EXE --smoke x -tokenPath $SCR/fake.token` | `offline badToken`, exit 2                       | **G9** closeCode → no-go: `closeReason` 문자열로 판별, 그것도 안 되면 serverDown + 문구에 "토큰" 안내                 |
| S5  | 서버 끈 채 `$EXE --smoke x` / `-tokenPath /nonexistent`                     | `offline serverDown` / `offline noToken`, exit 2 | 사유 분류                                                                                                             |
| S8  | `$EXE --smoke x --listen 30` 중 서버 `kill -TERM`                           | `offline shutdown`                               | shutdown 분류                                                                                                         |

결과(출력 요약·G6/G7/G9 판정)를 `_workspace/phase-execute/47-implementer-log.md` 에 남긴다(review 입력).

**G3(CI 러너) — 메인:** 첫 push 뒤 Actions 의 `mac` 잡 확인. no-go(Swift < 6.0 또는 Swift Testing 없음) → `mac.yml` **삭제 커밋** + review 기록. `continue-on-error` 금지, 테스트를 XCTest 로 바꾸지 않는다(U6).

---

## 밀스톤 M6 — 상태 리듀서 · 얼굴 파라미터 · 문구

> 커밋: `feat(phase47): add character state reducer and face params`

### M6-1. CREATE `apps/mac/Sources/FinClawMacCore/Copy.swift` (예산 50)

- **책임:** 사용자 문구 전부(plan §4-6 표) + 도구 문구 맵 + D6 제목 + 접근성 라벨(§4-1 표) + 버튼 라벨. 느낌표·이모지 없음.
- **공개 API:**

```swift
public enum Copy {
  public static func toolLabel(_ name: String) -> String?          // 마지막 "__" 뒤로 조회. get_current_datetime → nil
  public static func reason(_ r: String) -> String                 // auth / rate_limit / timeout / 그 외
  public static func offline(_ r: OfflineReason) -> String
  public static func alertTitle(_ alertName: String) -> String     // D6: "{SYMBOL} {condition}" 접미 → 제목
  public static func briefingTitle(_ name: String) -> String       // "브리핑 · {name}"
  public static func briefingFailed(_ name: String) -> String      // "브리핑 '{name}'을 만들지 못했어요"
  public static func firstLines(_ s: String, _ n: Int) -> String   // 브리핑 body = output 앞 6줄 (Notifier 도 씀)
  public static func accessibility(_ mood: Mood, toolLabel: String?, alertTitle: String?) -> String
  public static let requestFailed, reconnected, lostRun, resetDone, alertsUnavailable, inputPlaceholder: String
}
```

- `offline(.serverDown)` = **"서버가 꺼져 있어요 (`pnpm dev`)"** [TQ1]. 나머지 문자열은 plan §4-6 표 그대로 복사.
- `alertTitle`: `name` 을 마지막 공백으로 나눠 접미가 `price_above`/`price_below` → "{SYMBOL} 가격 알림", `change_percent` → "{SYMBOL} 등락 알림", `news_match` → "{SYMBOL} 뉴스 알림", 공백 없음·그 외 → "알림".

### M6-2. CREATE `apps/mac/Sources/FinClawMacCore/FaceParams.swift` (예산 60)

- **책임:** mood·시각만으로 정해지는 얼굴 값(plan §4-1 수식). 색 hex 상수도 여기(`Palette`) — 스냅샷·테스트가 같은 값.
- **공개 API:**

```swift
public enum Palette { public static let body = 0x4CC3AE, fin = 0x2E9C89, outline = 0x23786A, ink = 0x16302C,
                      cheek = 0xFF8FA3, amber = 0xF5A623, offlineBody = 0xA7B0AE }
public struct FaceParams: Equatable, Sendable {
  public enum Mouth: Equatable, Sendable { case none, smile(controlY: Double), dot(r: Double), line, oval(h: Double), wave }
  public enum Prop: Equatable, Sendable { case none, dots(lit: Int), spinner(angle: Double), bang, question, z }
  public enum Eyes: Equatable, Sendable { case open, closedArc, happyArc }   // ∪ / ∩
  public var eyes: Eyes, eyeOpen: Double, eyeScaleY: Double, eyeDX: Double, eyeDY: Double
  public var mouth: Mouth, breathX: Double, breathY: Double, tiltDeg: Double, finDeg: Double, jumpY: Double
  public var cheekOpacity: Double, browRaise: Double /* thinking 오른 눈썹 +3 */, worriedBrows: Bool
  public var prop: Prop, gray: Bool
  public static func at(mood: Mood, since: Date, now: Date, lastDeltaAt: Date?, reduceMotion: Bool) -> FaceParams
}
```

- **틀리기 쉬운 수식:** `t = now.timeIntervalSinceReferenceDate`(주기 함수용), `p = now - since`(진입 경과, alert 점프·지느러미 3Hz). reduceMotion 이면 t = 0, p = ∞(점프 없음), talking `open = 0.5`, 점·스피너 고정.

```swift
// 깜빡임 — 구간 k 의 시작 오프셋이 4.2 를 넘을 수 있으므로 직전 구간(k-1)도 본다
func blinking(_ t: Double) -> Bool {
  let k = Int(floor(t / 4.2))
  return [k - 1, k].contains { j in
    let h = Double(UInt64(bitPattern: Int64(j)) &* 2654435761 % 1000) / 1000   // 결정적 hash, 음수 안전
    let start = Double(j) * 4.2 + 3.0 + 2.5 * h
    return t >= start && t < start + 0.12
  }
}
// 입: open = |sin(2π·4.5t)| · max(0, 1 − (now − lastDeltaAt)/0.45)   (lastDeltaAt nil → 0)
// 숨: breathY = 1 + 0.025·sin(2πt/T), breathX = 1 − 0.012·sin(2πt/T), T = working ? 1.6 : 3.2, offline → 1
// alert: p < 0.6 → jumpY = −6·|sin(π·p/0.3)|, p < 1.2 → finDeg = 10·sin(2π·3t); 그 외 mood 진폭 × sin(2π·1.2t)
// working: spinner angle = (t mod 1.2)/1.2 · 360, eyeDX = 2·sin(2π·0.8t) · thinking: dots lit = Int(t / 0.4) % 3
```

- mood 별 눈·입·소품·볼은 plan §4-1 mood 표를 그대로 매핑(switch 1개).

### M6-3. CREATE `apps/mac/Sources/FinClawMacCore/CharacterReducer.swift` (예산 135 → ~140 [TQ4])

- **책임:** plan §4-2 타입(`Mood`·`Proactive`·`Bubble`·`CharacterState`·`CharacterEvent`·`CharacterReducer`) + 전이 표.
- **공개 API:** plan §4-2 그대로. 변경 1개 [TQ4f]: `activeTools: [ToolRun]`(`public struct ToolRun: Equatable, Sendable { public let id, label: String }`). Mac 타깃(스냅샷)이 샘플 상태를 만들므로 `Proactive`·`ToolRun` 은 **`public init` 을 명시**한다(Swift 는 public struct 의 memberwise init 을 internal 로만 합성). `Bubble` 에 `public var closesAt: Date?` 계산 프로퍼티.
- **상수:** happy 1.2 · offline 말풍선 지연 10 · notice 3 · lostRun 8 · error 5 · alert 60 · briefing 30 · 답 `clamp(4 + count/8, 6, 25)`(U5). config 키 없음.
- **표 → switch** (TQ4 a~f 반영):

```swift
public static func reduce(_ s: inout CharacterState, _ e: CharacterEvent, now: Date) {
  let before = s.mood
  defer { if s.mood != before { s.moodSince = now } }
  switch e {
  case .client(.connecting), .client(.disconnected), .client(.server(.shutdown)):
    if s.runId != nil { s.lostRun = true }
    s.runId = nil; s.activeTools = []; s.toolLabel = nil
    if s.offlineSince == nil { s.offlineSince = now }
    if case .client(.disconnected(let r)) = e { s.offlineReason = r }
    if case .client(.server(.shutdown)) = e { s.offlineReason = .shutdown }
    if case .answer? = s.bubble { s.bubble = nil }
    s.mood = .offline
  case .client(.connected):
    guard s.mood == .offline else { return }
    let long = s.offlineSince.map { now.timeIntervalSince($0) > offlineDelay } ?? false
    s.mood = .idle; s.offlineSince = nil; s.bubble = nil
    if s.lostRun { s.lostRun = false; s.bubble = .notice(Copy.lostRun, closesAt: now + lostRunSecs) }
    else if long { s.bubble = .notice(Copy.reconnected, closesAt: now + noticeSecs) }
  case .client(.server(let ev)): server(&s, ev, now)
  case .sent(let id):
    s.runId = id; s.mood = .thinking; s.bubble = .answer(text: "", closesAt: nil)
    s.lastDeltaAt = nil; s.activeTools = []; s.toolLabel = nil
  case .requestFailed: fail(&s, Copy.requestFailed, now)
  case .inputFocused(let b):
    s.inputFocused = b
    if b, s.mood == .idle { s.mood = .listening } else if !b, s.mood == .listening { s.mood = .idle }
  case .dismiss:
    guard s.runId == nil else { return }                           // [TQ4c]
    s.bubble = nil; showNextOrIdle(&s, now)
  case .setProactive(let b):
    s.proactiveEnabled = b
    if b, s.mood == .idle, s.bubble == nil { showNextOrIdle(&s, now) }
  case .notice(let msg):
    guard s.mood != .offline else { return }
    switch s.bubble { case .answer?, .proactive?: return; default: s.bubble = .notice(msg, closesAt: now + noticeSecs) }
  case .tick(let hold):
    if s.mood == .happy, now.timeIntervalSince(s.moodSince) >= happyHold { s.mood = .talking }
    if !hold, let c = s.bubble?.closesAt, now >= c { s.bubble = nil; showNextOrIdle(&s, now) }   // [TQ4d]
    if s.mood == .offline, s.bubble == nil, let since = s.offlineSince, now.timeIntervalSince(since) >= offlineDelay {
      s.bubble = .notice(Copy.offline(s.offlineReason ?? .serverDown), closesAt: .distantFuture)
    }
  }
}

static func server(_ s: inout CharacterState, _ ev: ServerEvent, _ now: Date) {
  switch ev {
  case .alertTriggered(let a):
    proactive(&s, Proactive(kind: .alert, key: a.alertId, title: Copy.alertTitle(a.name), body: a.message, detail: nil), now)
  case .scheduleCompleted(let c):
    let failed = c.error != nil
    proactive(&s, Proactive(kind: .briefing, key: c.scheduleId, title: Copy.briefingTitle(c.name),
                            body: failed ? Copy.briefingFailed(c.name) : Copy.firstLines(c.output, 6),
                            detail: failed ? nil : c.output), now)
  case .shutdown: break                                              // reduce 앞단에서 처리
  case .delta(let id, let text):
    guard id == s.runId else { return }
    if case .answer(let t, _)? = s.bubble { s.bubble = .answer(text: t + text, closesAt: nil) }
    else { s.bubble = .answer(text: text, closesAt: nil) }
    s.lastDeltaAt = now
    if s.mood != .working { s.mood = .talking }
  case .tool(let id, let callId, let name, let phase, _):            // isError 는 표정에 쓰지 않는다 (회귀 ①)
    guard id == s.runId else { return }
    if phase == .start {
      guard let label = Copy.toolLabel(name) else { return }        // get_current_datetime: 아무 일 없음
      s.activeTools.append(ToolRun(id: callId, label: label)); s.toolLabel = label; s.mood = .working
    } else {
      guard let i = s.activeTools.firstIndex(where: { $0.id == callId }) else { return }   // [TQ4e]
      s.activeTools.remove(at: i); s.toolLabel = s.activeTools.last?.label               // [TQ4f]
      s.mood = s.activeTools.isEmpty ? .thinking : .working
    }
  case .end(let id, let text):
    guard id == s.runId else { return }
    s.runId = nil; s.activeTools = []; s.toolLabel = nil
    s.bubble = .answer(text: text, closesAt: now + min(max(4 + Double(text.count) / 8, 6), 25))
    s.mood = .happy
  case .runError(let id, let reason):
    guard id == s.runId else { return }
    if reason == "aborted" {                                         // M10: error 를 거치지 않음
      s.runId = nil; s.activeTools = []; s.toolLabel = nil; s.bubble = nil
      showNextOrIdle(&s, now)                                        // [TQ4b]
    } else { fail(&s, Copy.reason(reason), now) }
  }
}

static func proactive(_ s: inout CharacterState, _ p: Proactive, _ now: Date) {
  if let i = s.queue.firstIndex(where: { $0.key == p.key }) { merge(&s.queue[i], p); return }
  if case .proactive(var cur, let c)? = s.bubble, cur.key == p.key { merge(&cur, p); s.bubble = .proactive(cur, closesAt: c); return }
  let busy: Bool = switch s.bubble { case .answer?, .error?, .proactive?: true; default: false }   // [TQ4a] proactive 표시 중도 큐
  if s.runId != nil || s.mood == .listening || busy || !s.proactiveEnabled { s.queue.append(p); return }
  show(&s, p, now)
}
static func merge(_ cur: inout Proactive, _ new: Proactive) { cur.count += 1; cur.body = new.body; cur.detail = new.detail }
static func show(_ s: inout CharacterState, _ p: Proactive, _ now: Date) {
  s.bubble = .proactive(p, closesAt: now + (p.kind == .alert ? alertSecs : briefingSecs)); s.mood = .alert
}
static func showNextOrIdle(_ s: inout CharacterState, _ now: Date) {                     // [TQ4b·d]
  guard s.mood != .offline else { return }
  if s.proactiveEnabled, !s.queue.isEmpty { show(&s, s.queue.removeFirst(), now) } else { s.mood = .idle }
}
static func fail(_ s: inout CharacterState, _ msg: String, _ now: Date) {
  s.runId = nil; s.activeTools = []; s.toolLabel = nil
  s.bubble = .error(msg, closesAt: now + errorSecs); s.mood = .error
}
```

(`let busy: Bool = switch …` 식 문법은 Swift 5.9+. 안 되면 클로저 즉시 호출.)

### M6-4. CREATE `apps/mac/Tests/FinClawMacCoreTests/ReducerTests.swift`

시각은 `let t0 = Date(timeIntervalSinceReferenceDate: 1_000)` 고정, `t0 + n`. `@Test` 만(MainActor 불필요 — 순수 함수).

| 케이스                                                       | Given / Then                                                                       |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------- |
| `disconnectFromAnyMoodGoesOffline` (회귀 ⑤, 9 mood 파라미터) | 각 mood + `.disconnected(.serverDown)` / offline                                   |
| `disconnectDuringRunSetsLostRun` (⑤)                         | sent r1 → disconnected / `lostRun`, `runId nil`, answer 말풍선 닫힘                |
| `connectedAfterLongOutageNotice`                             | offline 11s → connected / idle + notice "다시 연결됐어요" 3s                       |
| `connectedAfterShortOutageSilent`                            | offline 3s → connected / idle, 말풍선 없음                                         |
| `connectedWithLostRunNotice`                                 | lostRun → connected / notice `Copy.lostRun` 8s, lostRun false                      |
| `shutdownReason`                                             | `.server(.shutdown)` / offlineReason `.shutdown`                                   |
| `offlineNoticeAfter10s`                                      | offline + tick(9s) / 말풍선 없음, tick(10s) / `Copy.offline(r)` · distantFuture    |
| `inputFocusIdleListening`                                    | idle + focus(true) / listening, focus(false) / idle; thinking 중 focus 는 플래그만 |
| `sentGoesThinking`                                           | idle + sent r1 / thinking, `.answer("", nil)`                                      |
| `otherRunIdIgnored` (회귀 ②)                                 | sent r1 + delta(r2)·end(r2) / 변화 없음                                            |
| `nilRunIdIgnored`                                            | runId nil + delta(r1) / 무시                                                       |
| `deltaAccumulatesTalking`                                    | delta "가"·"나" / "가나", talking, lastDeltaAt                                     |
| `deltaDuringWorkingStaysWorking`                             | tool start → delta / working 유지                                                  |
| `toolStartWorkingWithLabel`                                  | tool start `mcp__finclaw__route_task` / working, "알아보는 중…"                    |
| `datetimeToolInvisible`                                      | tool start·end `get_current_datetime` (talking 중) / 그대로 talking [TQ4e]         |
| `toolEndBackToThinking`                                      | tool start → end / thinking, label nil                                             |
| `toolErrorIsNotError` (회귀 ①)                               | tool end isError true / thinking (error 아님)                                      |
| `parallelToolsKeepLatestLabel`                               | start A·B → end B / working, label = A [TQ4f]                                      |
| `endHappyWithClose`                                          | end "x"×80 / happy, closesAt = now + 14                                            |
| `happyToTalkingAfter1_2s`                                    | end → tick(1.1) / happy, tick(1.2) / talking                                       |
| `holdBubbleDefersCloseButNotHappy`                           | tick(holdBubble: true) 경과 / 말풍선 유지, happy→talking 진행                      |
| `abortedSkipsError` (회귀 ⑥)                                 | runError "aborted" / idle, 말풍선 없음                                             |
| `abortedShowsQueued`                                         | 큐 1개 + aborted / alert [TQ4b]                                                    |
| `runErrorMapsReason`                                         | runError "auth" / error, `Copy.reason("auth")` 5s                                  |
| `immediateRunErrorAfterSent`                                 | sent r1 직후 runError(r1,"timeout") / error                                        |
| `requestFailedAlways`                                        | idle + requestFailed / error, `Copy.requestFailed`                                 |
| `proactiveWhileIdleShows`                                    | idle + alertTriggered / alert, 60s; scheduleCompleted / 30s                        |
| `proactiveDuringRunQueues` (회귀 ③)                          | sent → alert → end → tick(답 closesAt) / alert(큐 항목)                            |
| `sameKeyMerges` (회귀 ④)                                     | 큐에 key A + A 다시 / 큐 길이 1, count 2, body 최신                                |
| `sameKeyOnScreenMerges`                                      | 화면 proactive A + A / count 2, closesAt 불변                                      |
| `otherKeyWhileProactiveQueues`                               | 화면 A + B / 큐 [B] [TQ4a]                                                         |
| `proactiveDisabledQueues`                                    | setProactive(false) + alert / 큐, idle 유지                                        |
| `enableShowsQueueHead`                                       | 큐 1 + setProactive(true) / alert                                                  |
| `briefingErrorBody`                                          | scheduleCompleted error≠nil / body `Copy.briefingFailed`, detail nil               |
| `briefingBodyFirst6Lines`                                    | output 10줄 / body 6줄, detail = 전문                                              |
| `dismissNextOrIdle`                                          | proactive + 큐 1 + dismiss / 다음 항목; 큐 없으면 idle                             |
| `dismissIgnoredDuringRun`                                    | sent + dismiss / 말풍선 유지 [TQ4c]                                                |
| `expiredProactiveWhileOfflineKeepsOffline`                   | offline + proactive closesAt 경과 tick / offline [TQ4d]                            |
| `noticeRules`                                                | idle + notice / 3s; answer 표시 중 notice / 무시; offline / 무시                   |

### M6-5. CREATE `apps/mac/Tests/FinClawMacCoreTests/FaceParamsTests.swift`

| 케이스                          | Given / Then                                                                                             |
| ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `blinkOnlyInWindow`             | k 구간들의 계산된 start / start..start+0.12 에서만 eyeOpen 0.1, 직전·직후 1                              |
| `blinkDeterministic`            | 같은 now 두 번 / 같은 값                                                                                 |
| `mouthClosesAfter0_45s`         | talking, lastDeltaAt = now − 0.46 / oval h == 1.5 (open 0)                                               |
| `reduceMotionIndependentOfTime` | reduceMotion, now 두 값 / 같은 FaceParams, talking open 0.5                                              |
| `offlineFrozen`                 | offline / breath 1·1, prop `.z`, gray                                                                    |
| `alertJumpOnlyFirst0_6s`        | alert since t0, now t0+0.15 / jumpY < 0; t0+0.7 / jumpY 0                                                |
| `spinnerPeriod1_2s`             | working, t 와 t+1.2 / 같은 angle                                                                         |
| `propsPerMood`                  | thinking dots · working spinner · alert bang · error question · idle none                                |
| `copyToolLabels`                | `toolLabel("mcp__finclaw__route_task") == "알아보는 중…"`, datetime nil, `mcp__x__foo` → "도구 사용 중…" |
| `copyAlertTitles`               | "AAPL price_above"/"price_below" → 가격, change_percent → 등락, news_match → 뉴스, "이상한값" → "알림"   |

### M6-6. 밀스톤 M6 검증

§0 Swift 게이트. `swift test` 신규 ~49 + M5 30 green. D7 줄 수(~635) 기록.

---

## 밀스톤 M7 — 플로팅 핀 · 말풍선 · 메뉴바 · 스냅샷 (G4·G8)

> 커밋: `feat(phase47): show the floating Pin character with chat bubbles`
> proactive 버튼·펼친 패널·폼은 M8. 이 밀스톤은 대화(send·abort·reset·스트리밍)까지.
> **D3:** 뷰는 `AppModel` 이 아니라 **상태 값 + 액션 클로저**를 받는다 → 스냅샷이 샘플 상태로 그대로 렌더.

### M7-1. CREATE `apps/mac/Sources/FinClawMac/CharacterPanel.swift` (예산 45)

- **책임:** [L1] §4 스니펫 그대로 + 내용 크기 변경 시 **우하단 고정** 리사이즈.
- **코드:** `_workspace/feature-research/mac-character/10-scout-L1-floating-companion.md` §4 의 `CharacterPanel`·`FirstMouseHostingView` 를 **그대로** 옮긴다(실측 빌드 경고 0). 추가 1개:

```swift
  /// 말풍선·펼침으로 내용 크기가 바뀌면 우하단 기준점을 유지한다 (AppKit 좌표: 원점 좌하단 → maxX·minY 고정).
  func fit(_ size: NSSize) {
    guard size != frame.size else { return }
    setFrame(NSRect(x: frame.maxX - size.width, y: frame.minY, width: size.width, height: size.height), display: true)
    ensureOnScreen()
  }
```

- 크기 보고: 루트 뷰가 `.background(GeometryReader { Color.clear.preference(key: SizeKey.self, value: $0.size) })` + `.onPreferenceChange(SizeKey.self) { onResize($0) }` → `panel.fit`. `NSHostingView.sizingOptions = []` 로 두어 호스팅 뷰가 창 크기를 따로 바꾸지 않게 한다. (Swift 6 에서 `onPreferenceChange` 클로저가 `@Sendable` 이면 `MainActor.assumeIsolated { … }` 로 감싼다.)

### M7-2. CREATE `apps/mac/Sources/FinClawMac/AppModel.swift` (예산 100 중 M7 ~70)

- **책임:** `@MainActor @Observable final class AppModel` — `CharacterState` 보유, 클라이언트 이벤트 → `reduce`, 0.5s tick, 액션. M8 에서 Notifier·패널·폼 액션 추가.
- **핵심:**

```swift
@MainActor @Observable final class AppModel {
  private(set) var state = CharacterState(now: .now)
  var hovering = false, expanded = false, input = ""
  @ObservationIgnored private var client: GatewayClient!     // init 안에서 self 캡처 때문에 지연 대입
  @ObservationIgnored private var timer: Timer?

  init() {
    client = GatewayClient(url: Settings.gatewayURL, tokenURL: Settings.tokenURL) { [weak self] ev in self?.apply(.client(ev)) }
    state.proactiveEnabled = UserDefaults.standard.object(forKey: "proactiveEnabled") as? Bool ?? true   // S9 기본 켜짐
    client.start()
    timer = Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { [weak self] _ in
      MainActor.assumeIsolated { guard let self else { return }; self.apply(.tick(holdBubble: self.hovering || self.expanded)) }
    }
  }
  func apply(_ e: CharacterEvent) { CharacterReducer.reduce(&state, e, now: .now) }   // M8: alert/schedule 이면 Notifier

  func send() {                                               // D4: run 중엔 뷰가 입력을 잠근다
    let msg = input.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !msg.isEmpty, state.runId == nil else { return }
    input = ""
    let id = UUID().uuidString.lowercased()
    apply(.sent(runId: id))                                   // §2-3: RPC 전에
    Task { do { try await client.send(msg, runId: id) } catch { apply(.requestFailed) } }
  }
  func abort() { guard let id = state.runId else { return }; Task { try? await client.abort(runId: id) } }
  func reset() { Task { do { try await client.reset(); apply(.notice(Copy.resetDone)) } catch { apply(.requestFailed) } } }
  func reconnect() { client.reconnect() }
  func setProactive(_ on: Bool) { UserDefaults.standard.set(on, forKey: "proactiveEnabled"); apply(.setProactive(on)) }
}
```

- `apply(.client(.server(.end)))` 직후 첫 문장 · alert 의 title+body 를 `AccessibilityNotification.Announcement(…).post()`(B9, 가격 알림은 우선순위 high) — 각 1회.
- `Settings`(M5-7 에서 만든 D1 enum)를 그대로 쓴다.

### M7-3. CREATE `apps/mac/Sources/FinClawMac/CharacterView.swift` (예산 105)

- **책임:** `TimelineView(.animation(minimumInterval: 1/30, paused: reduceMotion || mood == .offline))` + `CharacterCanvas(params:)` + 단일 `DragGesture(minimumDistance: 0)` + 큐 배지(B7) + 접근성(B9).
- **공개 형태:** `struct CharacterView: View { let state: CharacterState; let onTap: () -> Void; let onBadge: () -> Void }` · `struct CharacterCanvas: View { let params: FaceParams }`(스냅샷이 직접 씀).
- **Canvas 좌표 (plan §4-1 수치 표를 그대로 그린다):**

```swift
Canvas { ctx, size in
  let s = min(size.width, size.height) / 100                // 논리 100×100, 원점 좌상단, y 아래로
  ctx.scaleBy(x: s, y: s)
  ctx.translateBy(x: 0, y: p.jumpY)                          // 점프(음수 = 위)
  ctx.translateBy(x: 50, y: 90); ctx.rotate(by: .degrees(p.tiltDeg))
  ctx.scaleBy(x: p.breathX, y: p.breathY); ctx.translateBy(x: -50, y: -90)   // 숨쉬기 기준점 (50, 90)
  // 순서: 등지느러미(회전 기준점 (56,30), finDeg) → 몸 → 볼 → 눈 → 하이라이트 → 입 → 눈썹 → 소품
  // 몸: RoundedRect(14,28,72,62) r30, 채움 body|offlineBody, 외곽선 outline 2.0 (필수 — 흰 배경 대비 2.2:1)
  // 지느러미: move(44,30) quad(57,9 ctl 45,15) quad(68,31 ctl 66,20) close
  // 눈: 중심 (38,56)·(62,56)+(eyeDX,eyeDY), rx 5.5, ry 7.5·eyeOpen·eyeScaleY. 하이라이트 +(1.8,−2.8) r1.6 (closed/happy 생략)
  // 입 기준 (50,71) 선 2.0 round cap · 볼 (29,66)·(71,66) rx5 ry3 · 소품 기준 (84,24)
}
```

- `Color(hex:)` 헬퍼 4줄(`Palette` 정수 → `Color`). 캐릭터 색은 라이트·다크 동일(§4-1).
- **제스처(agentpet #55):** `onTapGesture` 금지. `DragGesture(minimumDistance: 0)` 의 `onChanged` 에서 이동량 ≥ 5pt 면 `window.setFrameOrigin(초기 origin + 이동량)`(y 부호 반전), `onEnded` 에서 총 이동량 < 5pt 면 `onTap()`. 창 참조는 `NSApp.windows.first { $0 is CharacterPanel }` 또는 AppModel 이 넘긴 클로저.
- 접근성: `.accessibilityElement()` + `.accessibilityLabel(Copy.accessibility(…))` + `.accessibilityHint("클릭하면 입력창이 열려요")`.
- 탭 동작(B8): `panel.makeKey()` + `@FocusState` true. proactive 표시에는 **`makeKey` 금지**(M11·P1) — `orderFrontRegardless()` 만.

### M7-4. CREATE `apps/mac/Sources/FinClawMac/BubbleView.swift` (예산 90 중 M7 ~55)

- **책임:** 말풍선(B1~B5) + 입력 `TextField`(B8). M8 에서 proactive 버튼·배지·"자세히 ▸" 추가.
- **공개 형태:** `struct BubbleView: View { let bubble: Bubble; let running: Bool; let toolLabel: String?; let onAbort: () -> Void; let onMore: () -> Void }` · `struct InputBar: View { @Binding var text: String; let disabled: Bool; let onSubmit: () -> Void; let onCancel: () -> Void; let onExpand: () -> Void }`.
- **6줄 + 페이드(B1) — 잘림 판정은 `ViewThatFits`:**

```swift
ViewThatFits(in: .vertical) {
  Text(md).frame(maxWidth: 300, alignment: .leading)                         // 다 들어가면 이것
  VStack(alignment: .leading, spacing: 2) {                                  // 아니면 6줄 + 24pt 페이드 + 자세히
    Text(md).lineLimit(6).frame(maxWidth: 300, alignment: .leading)
      .mask(LinearGradient(stops: [.init(color: .black, location: 0.75), .init(color: .clear, location: 1)],
                           startPoint: .top, endPoint: .bottom))
    Button("자세히 ▸", action: onMore).buttonStyle(.link)
  }
}
.frame(maxHeight: sixLineHeight)       // 6줄 높이 상한이 있어야 ViewThatFits 가 고른다
```

- 마크다운(B3): `(try? AttributedString(markdown: t, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(t)`. 타자 효과 없음(B2).
- 중지(B5): `running` 이면 `Button("중지", action: onAbort).keyboardShortcut(".", modifiers: .command)`. working 이면 `toolLabel` 한 줄(최소 유지 0.4s 는 뷰 `@State` 로).
- 입력(B8): placeholder `Copy.inputPlaceholder`, Enter → `onSubmit` 후 `resignKey`, Esc(`.onExitCommand`) → `onCancel`, `disabled`(run 중 — D4). 포커스 변화는 `.onChange(of: focused) { model.apply(.inputFocused($1)) }`.
- 배경: `.background(.regularMaterial, in: RoundedRectangle(cornerRadius: 12))`, 텍스트 `.primary`.

### M7-5. CREATE `apps/mac/Sources/FinClawMac/Snapshot.swift` (예산 35 중 M7 ~30)

- **책임:** `--snapshot <dir>` — 샘플 상태로 `ImageRenderer`(scale 2) → PNG. M7 = 13장(9 mood + 말풍선 4종), M8 = +패널 2종 = 15장(§8-1).
- **진입:** `@MainActor enum Snapshot { static func run(to dir: URL) }`. `TimelineView` 를 거치지 않고 `CharacterCanvas(params: FaceParams.at(mood:, since: t0, now: t0 + offset, lastDeltaAt:, reduceMotion: false))` 를 직접 렌더(G8). alert 은 offset 0.15(점프 중), talking 은 lastDeltaAt = now.

```swift
static func png(_ view: some View, _ url: URL) {
  let r = ImageRenderer(content: view.padding(8).background(Color.white))
  r.scale = 2
  guard let tiff = r.nsImage?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
        let data = rep.representation(using: .png, properties: [:]) else { print("render failed \(url.lastPathComponent)"); return }
  try? data.write(to: url)
}
```

- 파일명: `mood-{offline,idle,listening,thinking,working,talking,happy,alert,error}.png` · `bubble-answer-long.png`(10줄 답 + happy) · `bubble-streaming.png`(스트리밍 + 중지 + working "알아보는 중…") · `bubble-alert.png`(M7 에서는 proactive 말풍선 기본형만, 버튼·×2·배지는 M8) · `bubble-offline.png`(offline + `Copy.offline(.serverDown)`).

### M7-6. EDIT `apps/mac/Sources/FinClawMac/App.swift` — GUI 진입 + `--snapshot` + MenuBarExtra + Delegate (+~52)

`Entry.main()` 에서 `--smoke` 분기 뒤, 사용법/exit 64 를 대체:

```swift
    if let i = args.firstIndex(of: "--snapshot"), i + 1 < args.count {
      MainActor.assumeIsolated { Snapshot.run(to: URL(fileURLWithPath: args[i + 1], isDirectory: true)) }
      exit(0)
    }
    FinClawMacApp.main()
```

앱 골격은 [L1] §4 "함께 쓰는 앱 골격" 을 기반으로(`@main` 은 `Entry` 가 가지므로 `struct FinClawMacApp: App` 에는 붙이지 않는다):

- `Delegate.applicationDidFinishLaunching`: `NSApp.setActivationPolicy(.accessory)` → `AppModel()` 생성 → `CharacterPanel(rootView: RootView(model:, onResize:))` → `orderFrontRegardless()` → `didChangeScreenParametersNotification` 에서 `ensureOnScreen()`.
- `MenuBarExtra("FinClaw", systemImage: model.state.mood == .offline ? "zzz" : "face.smiling")` 5항목(§4-5): 캐릭터 보이기/숨기기(`panel.orderOut`/`orderFrontRegardless`) · 대화 새로 시작(`model.reset()`) · 먼저 말 걸기(Toggle → `model.setProactive`) · 재연결 · 종료. **`Settings` 씬 금지**(macOS 26 빈 창), `.contextMenu` 금지.
- `RootView`: 우하단 정렬 `VStack(alignment: .trailing) { BubbleView?; InputBar?(열렸을 때); CharacterView }` — 값과 클로저만 내려준다. 호버는 `.onHover { model.hovering = $0 }`.

### M7-7. 밀스톤 M7 검증

**자동(에이전트):**

```bash
cd apps/mac && swift build -c release 2>&1 | tail -3 && swift test 2>&1 | tail -5; cd -     # 경고 0
pnpm format && pnpm lint
find apps/mac/Sources -name '*.swift' -exec cat {} + | grep -cv '^[[:space:]]*$'            # ~990 기록
rm -rf <scratch>/snap && apps/mac/.build/release/FinClawMac --snapshot <scratch>/snap && ls <scratch>/snap | wc -l   # 13
```

- **G8 (에이전트 → 메인 육안):** 13장을 Read 로 본다 — 9 mood 가 서로 구분되는가, §4-1 소품(z·점 3개·스피너·!·?)·색(민트 몸 + 진한 외곽선, offline 회색, 강조는 앰버만), 말풍선 6줄 페이드·"자세히 ▸"·중지 버튼 위치. **no-go**(빈 PNG·Canvas 미렌더) → 스냅샷 경로만 `Path` 기반 `Shape` 조합으로 그린다(`CharacterCanvas` 의 그리기 함수를 `Path` 반환으로 바꾸고 Canvas·Shape 둘 다 그 Path 를 씀).
- GUI 실행 금지: 에이전트는 `FinClawMac`(인자 없음)을 띄우지 않는다.

**사람(review 로 이월 — 구현자는 시도하지 않음):** **G4** nonactivating 패널 TextField 키 입력·Enter 전송·포커스 복귀 — no-go 면 입력창만 `MenuBarExtra(.window)` 팝오버로 이동, 캐릭터는 표시 전용(파일 1개 교체). §8-3 #1~#5(화면 부분), #10~#14.

---

## 밀스톤 M8 — proactive · 알림 센터 · 대화 이력 · 알림 폼 · 번들 (G1)

> 커밋: `feat(phase47): notify alerts and briefings from the mac app`

### M8-1. CREATE `apps/mac/Sources/FinClawMac/Notifier.swift` (예산 25)

- **책임:** P2 시스템 알림. 번들 없는 실행 파일(`swift run`·스모크·스냅샷)에서는 아무것도 안 한다(`UNUserNotificationCenter.current()` 가 번들 없이 크래시).

```swift
import UserNotifications

@MainActor enum Notifier {
  static var enabled: Bool { Bundle.main.bundleIdentifier != nil }
  private static var asked = false
  static func post(id: String, title: String, body: String, active: Bool) {   // id = alertId | scheduleId → 교체 게시 (P3)
    guard enabled else { return }
    let center = UNUserNotificationCenter.current()
    if !asked { asked = true; center.requestAuthorization(options: [.alert, .sound]) { _, _ in } }
    let c = UNMutableNotificationContent()
    c.title = title; c.body = body                          // 본문 = 서버 결정적 문자열 (M2)
    c.interruptionLevel = active ? .active : .passive      // 가격·뉴스 .active + 기본 사운드, 브리핑 .passive (U4)
    if active { c.sound = .default }
    center.add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
  }
}
```

### M8-2. CREATE `apps/mac/Sources/FinClawMac/ChatPanelView.swift` (예산 45)

- **책임:** 펼친 패널 340×460pt, 상단 `Picker(.segmented)` "대화 | 알림" + "접기". 대화 = `chat.history{limit:20}` 결과 + 진행 중 run 텍스트, 하단 자동 스크롤(`ScrollViewReader` + `scrollTo(last)`). 브리핑 상세(U2): `detail` 이 있으면 같은 자리에 전문(고정폭 `Text(…).font(.body.monospaced())` 는 표·코드블록용이 아니라 전문 그대로) + "닫기".
- **공개 형태:** `struct ChatPanelView: View { let history: [HistoryLine]; let streaming: String?; let detail: String?; @Binding var tab: PanelTab; let onCollapse: () -> Void; let onCloseDetail: () -> Void; let alerts: AlertFormView }`. `struct HistoryLine: Decodable, Hashable { let role: String; let text: String }`(서버 `{role,text}` 그대로).

### M8-3. CREATE `apps/mac/Sources/FinClawMac/AlertFormView.swift` (예산 70)

- **책임:** 종목 `TextField` · 조건 segmented(이상/이하/등락률/뉴스) · 값 또는 키워드 · "만들기" → create, 목록(list) + 행마다 "삭제"(2단계: 첫 클릭 → 라벨 "한 번 더 누르면 기록까지 삭제돼요", 3s 안 두 번째 → delete).
- **요청 매핑(서버 enum 그대로):**

```swift
struct AlertCreate: Encodable { let symbol: String; let condition: String; let threshold: Double?; let keyword: String? }
// 이상 → "price_above"(threshold) · 이하 → "price_below"(threshold) · 등락률 → "change_percent"(threshold) · 뉴스 → "news_match"(keyword)
// nil 필드는 인코드 생략 (synthesized Encodable 이 encodeIfPresent)
struct AlertRow: Decodable, Identifiable { let id: String; let symbol: String; let condition: String; let threshold: Double?; let keyword: String? }
struct AlertList: Decodable { let alerts: [AlertRow] }
```

- 에러 표시: `RpcError.message` 가 `provider_unavailable` 로 시작하면 `Copy.alertsUnavailable`, 그 외 서버 message 그대로(`requires threshold` 등). 탭을 열 때·만들기·삭제 뒤 `finance.alert.list` 재조회.
- **공개 형태:** `struct AlertFormView: View { let rows: [AlertRow]; let error: String?; let onCreate: (AlertCreate) -> Void; let onDelete: (String) -> Void }` — 입력 필드 상태만 `@State`.

### M8-4. EDIT `apps/mac/Sources/FinClawMac/AppModel.swift` — proactive·이력·폼 액션 (+~30)

```swift
  func apply(_ e: CharacterEvent) {
    if case .client(.server(let ev)) = e { notify(ev) }        // 리듀서 큐·토글과 무관하게 항상 (P2·P6)
    CharacterReducer.reduce(&state, e, now: .now)
    if case .proactive? = state.bubble { panel?.orderFrontRegardless() }   // P1: makeKey 금지
  }
  private func notify(_ ev: ServerEvent) {
    switch ev {
    case .alertTriggered(let a): Notifier.post(id: a.alertId, title: Copy.alertTitle(a.name), body: a.message, active: true)
    case .scheduleCompleted(let c):
      Notifier.post(id: c.scheduleId, title: Copy.briefingTitle(c.name),
                    body: c.error == nil ? Copy.firstLines(c.output, 6) : Copy.briefingFailed(c.name), active: false)
    default: break
    }
  }
  // 펼침: expanded = true → history = try await client.call("chat.history", HistoryParams(sessionId:, limit: 20), as: HistoryResult.self).messages (1회)
  // 알림 탭: listAlerts() / createAlert(_:) / deleteAlert(_:) — 각 뒤에 listAlerts(). 실패는 alertError 에 저장
  // "설명 물어보기"(B6): input = "이 알림 설명해줘: \(body)" + 입력창 열기 — 전송하지 않는다 (M2·P7)
  // "자세히 ▸": 브리핑이면 detail = p.detail, 답이면 대화 탭으로 expanded = true
```

- `call` 은 `sessionId` 가 필요하므로 `GatewayClient` 에 `public var sessionId` 가 이미 있다(`private(set)`). history params 는 작은 `Encodable` struct.
- `Smoke.swift` 의 `title=` 을 `Copy.alertTitle(a.name)` 로(M5-7 메모).

### M8-5. EDIT `apps/mac/Sources/FinClawMac/BubbleView.swift` — proactive 말풍선·배지 (+~35)

- proactive(B6): 제목 굵게 + 본문 + `count ≥ 2` 면 "×N". alert → "이 알림 삭제"(2단계, 3s 창 — `@State armedAt: Date?`) + "설명 물어보기"(프리필 클로저). briefing → "자세히 ▸".
- 배지(B7): 캐릭터 우상단 앰버 원 + `state.queue.count`, 클릭 → `.dismiss`.
- 뷰 인자 추가: `onDeleteAlert: (String) -> Void`, `onExplain: (String) -> Void`, `onDetail: (String?) -> Void`.

### M8-6. EDIT `apps/mac/Sources/FinClawMac/Snapshot.swift` — +2장, alert 말풍선 완성

- `bubble-alert.png` = 가격 알림 ×2 + 배지 1 + 두 버튼 · `panel-chat.png`(샘플 이력 4턴) · `panel-alerts.png`(목록 2개 + 폼). 총 15장.
- D7 초과 시 **1순위로 패널 2종을 뺀다**(plan D7).

### M8-7. CREATE `apps/mac/scripts/bundle.sh` (U3)

```bash
#!/usr/bin/env bash
# phase47: release 빌드 → dist/FinClaw.app 조립 → ad-hoc 서명. 마지막 줄에 .app 경로를 출력한다.
set -euo pipefail
cd "$(dirname "$0")/.."
swift build -c release
APP=dist/FinClaw.app
rm -rf "$APP" && mkdir -p "$APP/Contents/MacOS"
cp .build/release/FinClawMac "$APP/Contents/MacOS/FinClawMac"
cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleIdentifier</key><string>local.finclaw.mac</string>
  <key>CFBundleName</key><string>FinClaw</string>
  <key>CFBundleExecutable</key><string>FinClawMac</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>0.1.0</string>
  <key>LSMinimumSystemVersion</key><string>14.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST
codesign --force --sign - "$APP"
echo "$APP"
```

`chmod +x apps/mac/scripts/bundle.sh`. 출력 `apps/mac/dist/` 는 기존 `dist/` 규칙으로 무시.

### M8-8. 밀스톤 M8 검증

**자동(에이전트):**

```bash
cd apps/mac && swift build -c release 2>&1 | tail -3 && swift test 2>&1 | tail -5; cd -
pnpm format && pnpm lint
find apps/mac/Sources -name '*.swift' -exec cat {} + | grep -cv '^[[:space:]]*$'     # ≤ 1,200 [TQ7]
bash apps/mac/scripts/bundle.sh
plutil -lint apps/mac/dist/FinClaw.app/Contents/Info.plist
codesign -dv apps/mac/dist/FinClaw.app 2>&1 | grep -E 'Signature=adhoc|Identifier=local.finclaw.mac'   # 둘 다
git status --short apps/mac/dist                                                      # 비어 있음 (무시됨)
apps/mac/.build/release/FinClawMac --snapshot <scratch>/snap && ls <scratch>/snap | wc -l   # 15
```

- 스냅샷 육안(메인): proactive 말풍선 ×2·배지·삭제/설명 버튼, 패널 2종.
- **실 서버 스모크(에이전트, 서버 기동은 M0-1 방식):**
  - **S7** — `$EXE --smoke "안녕" --listen 120` 중 다른 셸에서 `schedule.create{name:'m8-smoke', cron:'0 0 1 1 *', agentId:'default', prompt:'한 줄로 인사해줘', deliveryChannel:'web', deliveryTarget:'broadcast'}` + `schedule.runNow`(M0-2 스크립트의 rpc 헬퍼 재사용) → `event schedule.completed … error=false`.
  - **S6** — 시세·뉴스 키가 없으면 **미실행 기록** [TQ6]. 키가 있으면 현재가보다 낮은 `price_above` 를 `finance.alert.create` → `event alert.triggered …`.
- 에이전트는 `.app` 을 `open` 하지 않는다(사용자 부재 중 알림 권한 대화상자 방지 — [L23]).

**사람(review 로 이월):** **G1** ad-hoc `.app` 의 알림 권한·배너 — no-go 면 시스템 알림 없이 말풍선만 + review 기록, 재빌드마다 권한을 잃으면 README 안내. §8-3 #6~#9, #15, #17 의 권한 부분.

---

## 밀스톤 M9 — 문서

> 커밋: `docs(phase47): document the mac character app`

### M9-1. CREATE `apps/mac/README.md`

plan M9 "내용" 그대로: 요구사항(macOS 14+, Swift 6 툴체인 — Xcode 또는 Command Line Tools) · 서버를 먼저 실행(**`pnpm dev`** [TQ1]) · `bash apps/mac/scripts/bundle.sh && open apps/mac/dist/FinClaw.app` · 토큰은 `~/.finclaw/gateway.token` 을 접속마다 자동으로 읽음(Docker 서버는 호스트에 토큰이 없어 미지원 — Q11) · 포트 변경 시 `defaults write local.finclaw.mac gatewayURL ws://127.0.0.1:<port>/`(번들 없이 실행할 땐 `-gatewayURL` 인자) · 첫 실행 알림 권한 허용, 재빌드 후 다시 물을 수 있음(G1 결과 반영) · 기존 알림은 맥으로 오지 않으니 다시 만들기(예전 channels `['log','discord']`) · 브리핑은 `deliveryChannel: web` 만 · 페르소나는 기존 대화에 "대화 새로 시작" 뒤 적용 · "대화 새로 시작" 은 Web·TUI 와 공통(R4) · 개발 모드 `--snapshot <dir>`·`--smoke "<질문>" [--listen <초>]` · 테스트 `cd apps/mac && swift test`.

### M9-2. EDIT `README.md` — 5곳

1. L5 소개 문장: "Discord·Web UI·TUI 세 채널" → "Discord·Web UI·TUI 와 macOS 캐릭터 앱(핀)" 정도로 한 구절.
2. §4 운영 인터페이스 표에 행 1개: `| **macOS 캐릭터 앱** (SwiftUI) | `apps/mac`→`FinClaw.app`, gateway WS | 데스크톱 캐릭터 "핀" — 대화·가격 알림/브리핑 먼저 알림·알림 만들기/삭제 (`apps/mac/README.md`) |`.
3. §5 Gateway JSON-RPC: 제목의 메서드 수 +2(현재 값에 2를 더한다 — `grep -c "method: '" packages/gateway/src/rpc/methods/*.ts` 로 재확인), `chat.*` 행에 `history`, `finance.*` 행에 `alert.delete`. notification 줄에 `alert.triggered` 추가. `chat.send` 설명에 "`runId`(UUID)를 넘기면 그 값을 쓴다" 한 구절.
4. §환경변수 "선택 — Discord" 표에 `| DISCORD_ALERT_USER_ID | 가격·뉴스 알림 DM 수신자(Discord 사용자 id). DISCORD_BOT_TOKEN 과 함께 있을 때만 새 알림에 discord 채널. 설정 시 예전 ['log','discord'] 알림도 DM 됨 |`.
5. §패키지 구조 표 아래 한 줄: "`apps/mac/` — SwiftPM 패키지(외부 의존성 0, pnpm 워크스페이스 밖). `FinClawMacCore`(프로토콜·리듀서, `swift test`) + `FinClawMac`(실행 파일)."

### M9-3. EDIT `CONTRIBUTING.md:24` — scope 예시

```markdown
- `scope`: phase 작업이면 `phaseNN`, 아니면 패키지·영역 이름 (`agent`, `gateway`, `storage`, `mac` …). 생략 가능.
```

### M9-4. 밀스톤 M9 검증

- `pnpm format && pnpm lint` green(README·apps/mac/README 는 oxfmt 대상 — 표 정렬은 `pnpm format:fix`).
- 문서의 명령을 한 번씩 실행해 경로·이름 확인: `bash apps/mac/scripts/bundle.sh`(마지막 줄 경로), `apps/mac/.build/release/FinClawMac --snapshot <scratch>/x`, `cd apps/mac && swift test`, `defaults` 명령은 **읽기만**(`defaults read local.finclaw.mac 2>&1 | head -1`). `open …FinClaw.app` 은 실행하지 않는다(사람).

---

## 최종 검증 (PR 전)

```bash
pnpm format && pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:storage && pnpm test:ci
cd apps/mac && swift build -c release 2>&1 | tail -3 && swift test 2>&1 | tail -5; cd -
find apps/mac/Sources -name '*.swift' -exec cat {} + | grep -cv '^[[:space:]]*$'     # ≤ 1,200
git diff --stat 566cde9..HEAD -- packages | tail -1                                   # 서버 프로덕션 순증 ~+110
grep -rn "anthropic\|import Anthropic" apps/mac/Sources                               # 0 (M5 불변식)
```

기대: unit **1031** / storage **141** / 실패 0. Swift 테스트 ~79. 커밋 9개(M1~M9, M3 은 `fix`).

review 입력(구현자 로그 `_workspace/phase-execute/47-implementer-log.md`): G1·G3·G4·G6·G7·G8·G9 표(결과·폴백 적용 여부), S1~S8 출력 요약(S2·S6 키 없음 미실행 여부), 밀스톤별 Swift 줄 수, §8-3 항목별 "에이전트 확인 / 사람 확인 필요".

## 롤백 절차

밀스톤이 독립 커밋이라 역순 `git revert` 로 단계적 롤백 가능.

| 되돌릴 것              | 방법                                                          | 영향                                                                         |
| ---------------------- | ------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 맥 앱 전체             | M9·M8·M7·M6·M5 revert (또는 `apps/mac/`·`mac.yml` 삭제 1커밋) | 서버와 결합 0                                                                |
| CI 비용(G3 no-go 포함) | `mac.yml` 삭제 1커밋                                          | 로컬 `swift test` 게이트 유지                                                |
| 페르소나               | M4 revert (프롬프트 1파일 + 테스트 2줄)                       | 다음 CLI 세션 회전/`reset` 뒤 원래 말투                                      |
| Discord DM 수신자      | M3 revert                                                     | 예전 알림 DM 다시 불통(현행)                                                 |
| delete·history·runId   | M2 revert                                                     | 맥 앱 M7·M8 이 쓰므로 맥 앱도 함께                                           |
| 알림 websocket         | M1 revert                                                     | `'websocket'` 채널로 만든 알림은 "No handler" 로 실패 기록(데이터 손상 없음) |
