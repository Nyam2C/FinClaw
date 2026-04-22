# Phase 21 구현 리뷰

## Todo별 구현 일치도

| Todo | 항목                                                | 상태      | 비고                                                                     |
| ---- | --------------------------------------------------- | --------- | ------------------------------------------------------------------------ |
| 1    | RunnerExecutionAdapter + Stub                       | OK        | `packages/server/src/auto-reply/execution-adapter.ts` — Mock과 공존      |
| 2    | main.ts Milestone A 배선 (Discord → Claude)         | OK        | 커밋 `0e5cf6a` feat(server): activate auto-reply pipeline with Discord   |
| 3    | `@finclaw/skills-general` 패키지 (3 도구)           | OK        | 커밋 `56c2504` feat(skills-general): datetime/web_fetch/read_local_file  |
| 4    | upsertConversation + dispatcher adapter             | OK        | 커밋 `44bc9af` feat(server): wire storage + skills-general               |
| 5    | main.ts Milestone B (market tools + 영속성)         | OK        | 커밋 `9e82d1d` feat(server): wire market tools into auto-reply           |
| 6    | RPC chat/session factory 전환                       | OK        | 커밋 `30d47b0` refactor(server): convert chat/session RPC to factories   |
| 7    | Gateway Milestone C (TUI 스트리밍 배선)             | OK        | 커밋 `a346108` feat(gateway): wire chat.send to executeForTui            |
| 8    | Milestone D (`!finclaw reset/status` + 에러 가시성) | **DEFER** | **Phase 22로 이관** — plans/phase22/plan.md Milestone D2                 |
| 추가 | `.claude/` gitignore                                | OK        | 커밋 `a63c1e1` — Claude Code 런타임 아티팩트 추적 방지                   |
| 추가 | Docker 원클릭 스크립트 (`pnpm run setup / dev:all`) | OK        | 커밋 `4cee686` feat(docker): add pnpm setup and dev:all entrypoints      |
| 추가 | Dockerfile `prepare` 스크립트 복구                  | OK        | 커밋 `fd3d479` fix(pnpm): swallow lefthook install errors                |
| 추가 | docker-compose web vite preview 플래그 수정         | OK        | 커밋 `0853d61` fix(docker): use pnpm exec for vite preview               |
| 추가 | Discord sendTyping 크래시 수정 + DM 전달 폴백       | OK        | 커밋 `712b978` fix(channel-discord): survive unknown-channel errors      |
| 추가 | AnthropicAdapter `role:'tool'` 포맷 변환            | OK        | 커밋 `d8d6ae6` fix(agent): convert internal messages to Anthropic format |

## 상세 리뷰

### Milestone A — Discord MVP (Todo 1~2)

- `RunnerExecutionAdapter`가 `ExecutionAdapter` 인터페이스를 따라 MockExecutionAdapter와 공존. 기존 1282개 테스트 유지.
- `main.ts`가 62줄 → 206줄로 확장되며 `requireEnv` helper + `MissingEnvError` 도입 (환경 변수 부재 시 명시적 실패).
- **실측 검증**: Discord DM "안녕" 전송 → Claude 응답 수신 확인 (Gateway 로그 `Pipeline completed`).

### Milestone B — 도구 + 영속성 (Todo 3~5)

- `@finclaw/skills-general` 신규 패키지 3개 도구 모두 등록. `registerGeneralTools` 한 줄로 배선.
- `registerMarketTools` 조건부 호출: `ALPHA_VANTAGE_KEY || COINGECKO_API_KEY` 있을 때만.
- 실제 DB(`~/.finclaw/db.sqlite` 혹은 Docker `/data/db.sqlite`)에 `conversations`·`messages` 저장 확인 (sqlite 조회로 20 row 확인).

### Milestone C — TUI 스트리밍 (Todo 6~7)

- `executeForTui` 엔드포인트가 Runner 스트림을 WebSocket broadcaster로 직접 emit. TUI 클라이언트 측은 기존 구현으로 동작.
- chat/session RPC를 factory 패턴으로 전환 → 테스트 주입성 개선, 기존 테스트 업데이트 포함.

### Milestone D — 명령어 + 에러 가시성 (Todo 8) — **미완**

- `!finclaw reset/status` 명령어, 에러 Discord 전달 미구현.
- Phase 22 plan.md Milestone D2로 이관. 배선 전용 phase 특성상 기능 확장은 다음 Phase가 적절.

### 계획 외 추가 작업

초기 plan.md에 없던 작업 6건이 실제 기동·배포 과정에서 추가로 필요해 처리했다:

1. **Docker 환경 완성** — Phase 0 스캐폴드만 있던 Dockerfile이 Phase 21 기준 11개 패키지 중 7개만 COPY. 누락된 `infra/skills-general/tui/web` 추가 + web 빌드 + `/data` 권한 정리.
2. **`pnpm run setup / dev:all`** — `.env` 복사 + 의존성 설치 + Docker 기동 원클릭.
3. **런타임 버그 4건** — 실제 Discord 연결 후 발견:
   - lefthook이 컨테이너 내 `git` 부재로 `pnpm install` 실패 → `prepare` 스크립트 best-effort
   - `vite preview`의 `--` 구분자가 flag 무시 → `pnpm exec vite` 직접 호출
   - `ctx.senderId`를 채널 ID로 오용하여 `channels.fetch(userId)` 404 → 프로세스 크래시 → try/catch + DM 폴백
   - `AnthropicAdapter`가 `role:'tool'` 그대로 API에 전송 → 400 "Unexpected role" → `toAnthropicMessages()` 변환 레이어

이 4건은 **Phase 22의 Milestone D1에서 근본 수정**(MsgContext에 chatId 필드 추가) 예정.

## 발견 사항

### 근본 해결이 필요한 부채

1. **`ctx.senderId` ≠ `chatId`** (`packages/server/src/auto-reply/pipeline.ts:136`, `stages/deliver.ts:48/59`, `stages/ack.ts:81`)
   - Phase 21에서 `adapter.ts`의 `sendTyping` try/catch + `sender.ts`의 DM 폴백으로 **임시 우회**만 완료.
   - 근본적으로는 `MsgContext`/`PipelineMsgContext`에 `chatId: string` 필드를 추가하고 router가 `InboundMessage.metadata.discordChannelId`를 복사해야 함.
   - → Phase 22 Milestone D1.

2. **web 컨테이너 healthcheck**
   - Dockerfile의 `HEALTHCHECK`가 server의 `/healthz`를 찌르지만 web 컨테이너에도 동일 이미지를 쓰기 때문에 항상 `unhealthy` 표시.
   - 기능 영향은 없으나 운영 관측을 방해.
   - → Phase 22 Milestone D3 (`docker-compose.yml`의 web 서비스에 healthcheck override).

3. **`tool_calls` JSON에 input/output 미저장** (`packages/storage/src/tables/messages.ts`)
   - 현재 이름·id 정도만 직렬화. 금융 파트너 관점에서 "왜 그 판단?" 사후 추적이 어려움.
   - → Phase 22 Milestone C2.

### 리팩토링 후보 (즉시 필요하진 않음)

1. **`AnthropicAdapter.toAnthropicMessages` 함수형 재작성**
   - 현재 `for-of + if/else` 구조. 타입 좁히기가 강해 flatMap union 이슈를 회피.
   - 향후 `ContentBlock` 종류가 늘어나면 switch/exhaustive check 기반으로 전환 검토.

2. **`sender.ts`의 10003 fallback 제거**
   - D1 수정 후 `targetId`가 항상 진짜 채널 ID가 되면 fallback 로직 자체가 불필요 → 제거 가능.

3. **`DEFAULT_SYSTEM_PROMPT` 상수가 평문**
   - Phase 22 Milestone A에서 금융 파트너 페르소나로 재작성 시, 여러 곳에서 재사용 가능하도록 상수화·모듈화 검토.

4. **Dockerfile `pnpm install --prod` 제거됨**
   - `vite preview`가 devDep이라 prod-only 제거. 이미지 크기 650MB로 큼.
   - 본격 배포 시엔 web 빌드 산출물만 별도 정적 서빙 (nginx 등)으로 분리 검토.
