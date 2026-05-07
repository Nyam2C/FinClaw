# QA Checklist — phase-qa-engineer 체크리스트

## 1. 환경

- 작업 디렉토리: 프로젝트 루트
- Node.js 22+ (CLAUDE.md 명시)
- pnpm 사용
- 모든 명령은 root scripts 경유 (`pnpm <script>`), workspace 단위는 `pnpm -F <pkg> <script>`

## 2. TODO 일치도 검증

`plans/phase{NN}/todo.md` 가 다음과 같은 단계 표기를 쓴다 가정:

- `P-1`, `P-2` ... — 사전 작업 (스키마, 의존성)
- `Step 1`, `Step 2` ... — 본 구현
- `T-1`, `T-2` ... — 테스트 추가
- 또는 `밀스톤 A`, `밀스톤 B` ... 형식

각 단계마다:

| 단계   | 파일                       | 상태      | 비고                |
| ------ | -------------------------- | --------- | ------------------- |
| P-1    | `packages/storage/src/...` | ✅ 완료   | todo.md 코드와 일치 |
| Step 3 | `packages/server/src/...`  | ⚠️ 편차   | import 경로만 다름  |
| T-2    | `packages/.../foo.test.ts` | ❌ 미구현 | 파일 부재           |

라벨 정의:

- **✅ 완료** — todo.md 코드와 본질 일치 (변수명/주석 차이 무시)
- **⚠️ 편차** — 정당한 차이 (사유 명시 필수)
- **❌ 미구현** — 파일/함수/테스트 자체 부재
- **🔄 부분** — 일부만 구현, 나머지 누락

검증 방법:

1. todo.md 의 코드 스니펫에서 핵심 식별자 (함수명, 타입명, export) 추출
2. 해당 파일을 Read 로 읽어 식별자 존재 확인
3. 시그니처 / 본질 로직 비교 (변수명·주석·공백 무시)
4. 테스트 단계는 `*.test.ts` 가 존재하고 vitest 가 잡는지 확인

## 3. 자동화 명령

### 3.1 항상 실행

```bash
pnpm typecheck    # tsgo --noEmit
pnpm test --run   # vitest run (unit)
pnpm test:storage # vitest run --config vitest.storage.config.ts
pnpm lint         # oxlint --config oxlintrc.json .
```

각 명령 후 기록:

- 종료 코드
- 실패 항목 수
- 핵심 에러 메시지 (3 줄 이내)

### 3.2 옵션 (사용자 명시 시만)

```bash
pnpm test:e2e     # vitest --config vitest.e2e.config.ts
pnpm test:live    # vitest --config vitest.live.config.ts (외부 API 키 필수)
```

### 3.3 빌드 (대체 검증)

```bash
pnpm build        # tsc --build (project references 전체)
```

typecheck 가 빠지지 않은 cross-package 경계까지 잡으므로, typecheck PASS 인데 build FAIL 가능. typecheck PASS 시 한 번 build 도 실행 권장.

## 4. mock-only 격리 검증

### 4.1 외부 API 키 없이 통과 확인

CLAUDE.md feedback: "유닛 테스트는 mock 기반, 실제 외부 키/네트워크 호출 금지". 검증:

```bash
env -u ANTHROPIC_API_KEY -u KIS_APP_KEY -u KIS_APP_SECRET \
    -u DISCORD_TOKEN -u OPENAI_API_KEY \
    pnpm test --run
```

PASS 여야 정상. 실패 시 어떤 테스트가 외부 키를 요구했는지 인용 → 위험 신호 P0.

### 4.2 새 테스트의 mock 패턴

phase 가 추가한 `*.test.ts` 파일 검토:

| 패턴                                            | 평가           |
| ----------------------------------------------- | -------------- |
| `vi.mock('node:fetch')` 또는 mock provider 사용 | ✅             |
| `process.env.X` 직접 require (mock 없음)        | ❌ — 위험 신호 |
| 테스트 안에서 실제 `fetch()` 호출               | ❌             |

## 5. 마이그레이션 시뮬레이션

`packages/storage/src/database.ts` 의 `SCHEMA_VERSION` 이 phase 에서 bump 됐다면:

1. 이전 버전 DB 파일을 fixture 로 가진 테스트가 존재하는가?
2. `pnpm test:storage` 안에서 마이그레이션 시뮬레이션 통과하는가?
3. 마이그레이션이 idempotent 한가? (재실행 시 안전)
4. FK CASCADE / 인덱스 변경이 plan.md 와 일치하는가?

## 6. 경계면 교차 검증

**핵심: 두 면을 동시에 읽고 shape 비교**. "존재" 만 확인하지 않는다.

### 6.1 RPC ↔ Web/TUI

| 측면            | 위치                                               |
| --------------- | -------------------------------------------------- |
| RPC 메서드 정의 | `packages/server/src/gateway/rpc/methods/*.ts`     |
| Web 호출        | `packages/web/src/**/use-*.ts`, `app-gateway`      |
| TUI 호출        | `packages/tui/src/**/*.ts` (rpc 클라이언트 사용처) |

검증:

1. RPC method 의 Zod 응답 스키마 → 객체 키 목록 추출
2. UI 의 destructure 위치에서 사용 키 목록 추출
3. 누락 (UI 가 쓰는 키가 응답에 없음) — ❌ P0
4. 잉여 (응답에 있으나 UI 가 안 씀) — ⚠️ 정보 (의도된 forward compat 일 수 있음)

### 6.2 storage ↔ RPC

| 측면            | 위치                                           |
| --------------- | ---------------------------------------------- |
| 테이블 row 타입 | `packages/storage/src/tables/*.ts`             |
| RPC 응답 변환   | `packages/server/src/gateway/rpc/methods/*.ts` |

snake_case ↔ camelCase 변환 누락, 컬럼 추가됐는데 RPC 가 반영 안 함, 등.

### 6.3 pipeline ↔ prompt

| 측면                 | 위치                                                  |
| -------------------- | ----------------------------------------------------- |
| 컨텍스트 채움        | `packages/server/src/auto-reply/stages/*.ts`          |
| 프롬프트 placeholder | `packages/*/prompts/*.ts`, `packages/server/prompts/` |

stage 가 채우지만 prompt 가 안 읽음, 또는 prompt 가 읽지만 stage 가 안 채움 — ❌.

### 6.4 broadcaster ↔ subscriber

| 측면 | 위치                                                                           |
| ---- | ------------------------------------------------------------------------------ |
| 발신 | `packages/server/src/gateway/broadcaster.ts`, `broadcastToChannel(...)` 호출지 |
| 수신 | `packages/web/src/**/*ws*.ts`, `subscribe(...)` 호출지                         |

토픽 이름 typo, payload shape 불일치, 발신만 있고 구독 없음.

### 6.5 channel ↔ auto-reply

| 측면          | 위치                                                                    |
| ------------- | ----------------------------------------------------------------------- |
| 채널 이벤트   | `packages/channel-discord/src/...`, `packages/server/src/channels/*.ts` |
| pipeline 진입 | `packages/server/src/auto-reply/pipeline.ts`                            |

채널이 emit 하는 이벤트 shape 과 pipeline 이 받는 shape 일치.

## 7. 위험 신호 (P0)

다음은 발견 즉시 SendMessage 로 메인에 알림:

- typecheck FAIL
- vitest unit/storage FAIL (skip 은 ⚠️)
- mock-only 검증 FAIL (외부 키 요구)
- RPC ↔ UI shape 불일치 (UI breaking)
- 마이그레이션 시뮬레이션 FAIL (DB 호환성 깨짐)
- 새 시크릿/API 키가 코드 안에 하드코딩

## 8. 보고서 출력 규칙

- 모든 검증 결과에 명령 출력 일부 인용 (5 줄 이내)
- 통과한 항목도 명시 (skip 안 함)
- "검증 안 함" 항목은 사유 명시 (예: "phase 가 storage 안 건드려서 마이그레이션 시뮬레이션 생략")
