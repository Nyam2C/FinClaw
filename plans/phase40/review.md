# Phase 40 Review — Claude 구독(CLI)-only + MCP 도구

> base `d5db716` (phase39 #74) → HEAD `907ca8c`. 6 커밋(docs + A~E). 28 코드/테스트 + 4 문서 파일.
> 모드 A 산출물 — phase-refactor-expert + phase-qa-engineer 통합. 승인 시 `plans/phase40/review.md` 로 머지.

## 1. 구현 사항 (TODO 일치도: ✅ 38 / ⚠️ 4 / ❌ 0)

A~E 전 밀스톤 코드 단계 실제 파일에 구현 완료, 미구현 0.

| 밀스톤 | 산출                                                                                         | 커밋      |
| ------ | -------------------------------------------------------------------------------------------- | --------- |
| A      | in-process HTTP MCP 호스트 (`gateway/src/mcp/host.ts`, **stateful 세션맵** `createMcpHost`)  | `d833bae` |
| B      | 제너릭 브리지 (`mcp/bridge.ts`, read-only-first `DEFAULT_MCP_TOOL_DENY`) + `signToken` HS256 | `09e87fe` |
| C      | CLI runner MCP 배선 (`runner.ts` — `--mcp-config`http + `--tools ""` 격리)                   | `f4d2b27` |
| D      | 키 없이 부팅 + provider 기본 `claude-cli` + SDK optional 전파                                | `e4a7536` |
| E      | CLI 비용(`total_cost_usd`→estimatedCostUsd) 회계 + README 정정                               | `907ca8c` |

**⚠️ todo 대비 정당한 편차 4건 (모두 구현이 더 옳음):**

- **A1/A3 (stateless→stateful):** todo 의 stateless 가정이 MCP-over-HTTP 에서 `tools/list` -32601 로 실패 → mcp-session-id 세션맵으로 진화. plan §1-1 이 이미 보정. **todo 가 stale.**
- **B3:** group allowlist 만 있던 todo → `DEFAULT_MCP_TOOL_DENY` + `allowTools` opt-in 으로 read-only 강화. abortSignal 은 `extra.signal`(요청 수명) 전파.
- **C (격리):** `--permission-mode bypassPermissions` 대신 base args 의 `--dangerously-skip-permissions` 재사용 (동일 효과, 중복 회피).
- **E1:** `mcp:request` 신규 이벤트 미추가 — 기존 `tool:*` 이벤트로 audit 충족 (CLAUDE.md §2 최소 코드).

## 2. 자동화 검증 결과 (전부 GREEN)

| 항목                       | 결과                                                |
| -------------------------- | --------------------------------------------------- |
| `pnpm typecheck`           | ✅ PASS (exit 0)                                    |
| `pnpm test --run` (unit)   | ✅ **1700 pass / 0 fail** (baseline 1679 + 21 신규) |
| `pnpm test:storage`        | ✅ **154 pass** (불변)                              |
| `pnpm lint`                | ✅ 0 warnings / 0 errors                            |
| `pnpm build` (tsc --build) | ✅ clean                                            |

mock-only 격리 ✅ — 신규 테스트 전부 `vi.spyOn` mock, 실 키/네트워크/라이브 CLI 0건. A8 라이브 spike 는 수동 분리.

## 3. 경계면 검증 (5/5 PASS)

- `/mcp` 핸들러 ↔ bridge 도구 노출 shape ✅
- `signToken` ↔ `validateToken` round-trip (sessionId claim 운반) ✅
- runner MCP argv ↔ `--mcp-config` JSON(http+Bearer) 형태 ✅
- providers/runtime 의 `|undefined` optional 전파 ↔ 소비처(execution-adapter routerLlm?, pipeline summarizer?) ✅
- `config.provider` 기본값 `anthropic-sdk`→`claude-cli` 변경 ↔ 기존 테스트 충돌 0 ✅

## 4. 리팩토링 사항

**P0: 없음.** 경계 위반·순환(server→gateway 단방향 정상)·죽은 import·과도한 에러처리 모두 clean.

**✅ 해결됨 (`2b1c513`):** `jsonSchemaToZodType` 사본 제거 → registry 의 `jsonSchemaToZod` 를 export 해 bridge 가 직접 import (단일 소스). **drift 구조적으로 불가능.** (당초 P1 위험이었으나 즉시 수정.)

**P1 (검토 권장, 차단 아님):**

- **`bridge.ts` `allowTools` opt-in 축** — 현재 호출자 미주입(죽은 유연성 의심, §2) but 사용자 read-only 안전망 의도. **삭제 vs 유지 결정 필요.**
- **`host.ts:93-100` 인라인 `readBody`** — router.ts 와 중복 가능 (순환 import 회피용이라 정당하나 leaf 모듈 추출 검토).
- **`providers.ts:51-66` `cliBackend` 3중 spread 중첩** — 가독성(선택).

**P2 (사소):** host 가 전체 config 수신 / 단일사용자라 per-session identity 무의미 / `mergeUsage` costUsd 비대칭 삼항 / `signToken.permissions` 미사용 파라미터 / 경고 제거 후 빈 주석.

## 5. 범위 밖 발견 (참고)

scope creep 없음. README 갱신 = 밀스톤 E 명시 범위. **stale 헤더 주석·죽은 re-export 등 phase39 P3 백로그 미건드림 (CLAUDE.md §3 준수).**

## 6. 위험 신호

- **✅ (해결) `jsonSchemaToZod` 미러 drift:** `2b1c513` 에서 단일 소스화 — 사본 제거, registry 변환기 직접 import. 더 이상 위험 아님.
- **🟡 최종 수동 e2e 미실행:** 키 없는 full server 부팅 → 실제 채팅 end-to-end 는 미검증 (`/mcp` 경로 자체는 A8 라이브로 GO 확인). 머지 전/후 1회 권장.
- **🟢 news-brief cron CLI 모드 skip:** `brokerage_sync_holdings` 가 read-only deny 라 의도된 degrade. "스케줄 뉴스 브리프 = SDK 모드 전용" 사용자 기대치 문서화 권장.

## 7. 다음 phase 후보 (phase41 — `_workspace/phase41-scope.md` 상세)

- **analyze_market → runCliAgent 재배선** (SDK 직접 호출 제거, 구독 사용). ★ 중첩 spawn 데드락 회피(inner 전용 queueKey/stateless) 필수.
- **`sentiment.ts:14` `analyzeSentiment` 죽은 코드 삭제** (src 호출처 0건 — kickoff 승인 후).
- **`BrokerageClient` 인터페이스 추출** → KIS/Toss 구현 분리 (Toss 실 구현은 API 발급 후 별 phase). KIS 종속은 `kis/{auth,client,holdings}.ts` + `skills.ts` 배선 4곳뿐, 나머지는 이미 벤더 중립.
- (선택) summarizer SDK 의존 정리, news-brief CLI 모드 별도 결정.
