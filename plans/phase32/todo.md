# Phase 32 — Todo

`plans/phase32/plan.md` 의 8 밀스톤 + 통합 + live e2e.

**환경 prerequisite (사용자 1회 수행):**

- [ ] `claude` CLI 설치
- [ ] `claude login` 으로 Claude Max OAuth 인증
- [ ] `claude -p --output-format json "say ok"` 동작 확인

## 밀스톤 A — CLI Backend Config (4h)

- [ ] `packages/agent/src/providers/claude-cli/types.ts` 신규 — `CliBackendConfig`, `CliWatchdogProfile`, `CliReliabilityConfig`, `CliOutputMode`
- [ ] `packages/agent/src/providers/claude-cli/backends.ts` 신규 — OpenClaw `cli-backends.ts:36-95` 이식
  - [ ] `DEFAULT_CLAUDE_BACKEND` (clearEnv = `['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_OLD']`)
  - [ ] `CLAUDE_MODEL_ALIASES` (opus/sonnet/haiku 별칭)
  - [ ] `resolveClaudeBackend(override)` (clearEnv union merge)
  - [ ] `normalizeClaudeModel(modelId, backend)` (case-insensitive alias)
- [ ] `packages/agent/test/providers/claude-cli/backends.test.ts` 신규 — 7 테스트 (clearEnv, dangerously-skip-permissions, json output, session-id, override merge, alias, passthrough)
- [ ] `pnpm test --filter @finclaw/agent -- claude-cli/backends` 통과

## 밀스톤 B — Watchdog Ratio (2h)

- [ ] `packages/agent/src/providers/claude-cli/reliability.ts` 신규 — OpenClaw `cli-runner/reliability.ts:1-80` 이식
  - [ ] 상수: `CLI_WATCHDOG_MIN_TIMEOUT_MS=5000`, `FRESH/RESUME_WATCHDOG_DEFAULTS`
  - [ ] `pickWatchdogProfile(backend, useResume)` — ratio clamp 0.05~0.95, min/max 정렬
  - [ ] `resolveCliNoOutputTimeoutMs({backend, timeoutMs, useResume})` — `cap = timeoutMs - 1000` 강제
- [ ] `packages/agent/test/providers/claude-cli/reliability.test.ts` 신규 — 5 테스트 (fresh/resume ratio, cap, explicit override, ratio clamp)
- [ ] `pnpm test --filter @finclaw/agent -- claude-cli/reliability` 통과

## 밀스톤 C — Process Spawn + Queue (1d)

- [ ] `packages/agent/src/providers/claude-cli/queue.ts` 신규 — OpenClaw `cli-runner/helpers.ts:24-40` 이식
  - [ ] `enqueueCliRun(key, task)` — 같은 key 직렬화, 실패 시 unhandled rejection 방지
  - [ ] `buildCliQueueKey({backendId, cliSessionId})` — 같은 session 동시 실행 방지
- [ ] `packages/agent/src/providers/claude-cli/spawn.ts` 신규 — child_process spawn + watchdog
  - [ ] `SpawnRequest` / `SpawnResult` / `SpawnReason` 타입
  - [ ] `spawnWithWatchdog(req)` — stdout/stderr 수집, no-output-timeout (slide window), overall-timeout, abort signal, SIGTERM → 2s 후 SIGKILL
- [ ] `packages/agent/test/providers/claude-cli/queue.test.ts` 신규 — 2 테스트 (same-key serialize, different-key parallel)
- [ ] `packages/agent/test/providers/claude-cli/spawn.test.ts` 신규 — 3 테스트 (success, overall-timeout, no-output-timeout)
- [ ] `pnpm test --filter @finclaw/agent -- claude-cli/queue claude-cli/spawn` 통과

## 밀스톤 D — JSON/JSONL Parsers (3h)

- [ ] `packages/agent/src/providers/claude-cli/parsers.ts` 신규
  - [ ] `parseCliJson(stdout, backend)` — claude CLI 의 `{ type: 'result', result: '...', session_id, usage }` 형식
  - [ ] `parseCliJsonl(stdout, backend)` — codex 류 line-by-line, text 누적 + 첫 sessionId
  - [ ] `pickText` (result/text/content[]/message), `pickSessionId` (sessionIdFields), `pickUsage` (input_tokens/output_tokens/cache_read_input_tokens 등 정규화), `mergeUsage`
- [ ] `packages/agent/test/providers/claude-cli/parsers.test.ts` 신규 — 5 테스트 (claude json, empty, invalid json, jsonl 누적, sessionId pick)
- [ ] `pnpm test --filter @finclaw/agent -- claude-cli/parsers` 통과

## 밀스톤 E — runCliAgent Core (1d)

- [ ] `packages/agent/src/providers/claude-cli/errors.ts` 신규
  - [ ] `CliFailoverError` 클래스 (reason union: auth/rate_limit/timeout/format/model_not_found/unknown)
  - [ ] `classifyCliError(message)` — TIMEOUT_RE / AUTH_RE / RATE_LIMIT_RE 정규식
- [ ] `packages/agent/src/providers/claude-cli/runner.ts` 신규 — A~D 조합
  - [ ] `runCliAgent(req)` — backend resolve → modelId 정규화 → useResume 결정 → args/env 빌드 (clearEnv 적용) → queue → spawnWithWatchdog → 에러 분류 throw → 출력 파싱
  - [ ] no-output-timeout / overall-timeout / aborted / classify message 4 분기
- [ ] `packages/agent/test/providers/claude-cli/runner.test.ts` 신규 — 5 테스트 (success json, no-output-timeout, auth error, clearEnv 검증, --resume 분기)
- [ ] `pnpm test --filter @finclaw/agent -- claude-cli/runner` 통과

## 밀스톤 F — ProviderAdapter Dual-Path (1d)

- [ ] `packages/agent/src/providers/claude-cli/adapter.ts` 신규
  - [ ] `CliProviderAdapter` 클래스 — `id='claude-cli'`, `supportsStreaming=false`, `supportsPromptCaching=false`, `supportsToolUse=false`
  - [ ] `streamCompletion(req)` — messages 직렬화 + runCliAgent 위임 + SDK 응답 형식 변환
- [ ] `packages/agent/src/providers/factory.ts` 신규 — `createProviderAdapter(cfg)` 분기
- [ ] `packages/config/src/schema.ts` 수정 — `provider: z.enum(['anthropic-sdk', 'claude-cli']).default('anthropic-sdk')` + `cliBackend` 옵션
- [ ] `packages/server/src/main.ts` 수정 — `createProviderAdapter` 사용, CLI 모드 시 부트 로그 경고
- [ ] `packages/agent/test/providers/claude-cli/adapter.test.ts` 신규 — 6 테스트 (capabilities, message 직렬화, factory 분기, missing apiKey throw)
- [ ] `pnpm test --filter @finclaw/agent -- claude-cli/adapter` 통과

## 밀스톤 G — agent_runs + Auth Fallback (4h)

- [ ] `packages/storage/src/database.ts` — SCHEMA_VERSION v10 → v11
- [ ] 마이그레이션: `ALTER TABLE agent_runs ADD COLUMN cli_session_id TEXT` + index
- [ ] `packages/storage/src/agent-runs.ts` 수정 — `cliSessionId?` 추가, `updateAgentRun({cliSessionId})` 헬퍼
- [ ] `packages/agent/src/execution/runner.ts` 수정 — `streamCompletion` 결과의 `metadata.cliSessionId` 를 agent_runs 에 저장
- [ ] runner 에 `fallbackProvider?` 옵션 — `CliFailoverError` 의 `reason==='auth'` 시 SDK fallback
- [ ] `packages/storage/test/migrations/v10-to-v11.test.ts` 신규 — 마이그레이션 simulation
- [ ] `packages/agent/test/execution/cli-fallback.test.ts` 신규 — 2 테스트 (auth → SDK fallback, non-auth → throw without fallback)
- [ ] `pnpm test:storage -- v10-to-v11 && pnpm test --filter @finclaw/agent -- cli-fallback` 통과

## 밀스톤 H — Live e2e (4h)

**환경**: `claude` CLI 설치 + `claude login` 완료 필수.

- [ ] `packages/agent/test/providers/claude-cli/runner.live.test.ts` 신규
  - [ ] `describe.skipIf(!claudeAvailable)` — claude CLI 미설치 환경 자동 skip
  - [ ] 시나리오 1: 단일 발화 → 응답 + sessionId 발급 확인
  - [ ] 시나리오 2: multi-turn (`--resume`) — 이름 기억 검증 (180s timeout)
  - [ ] 시나리오 3: ANTHROPIC_API_KEY=invalid 환경에서도 OAuth 로 정상 동작 (clearEnv 검증)
- [ ] `pnpm test:live -- providers/claude-cli` 통과
- [ ] `pnpm test` (mock-only) 회귀 0 — live test 가 자동 skip

## 통합 시나리오

- [ ] **시나리오 1 — config 토글**: `provider: 'claude-cli'` → 부트 로그 경고 표시 + Discord 응답 정상 → `provider: 'anthropic-sdk'` 복귀 → SDK 모드 정상
- [ ] **시나리오 2 — Multi-turn**: CLI 모드 메시지 2개가 같은 cli_session_id 공유 (agent_runs 두 row)
- [ ] **시나리오 3 — Auth fallback**: CLI auth 만료 시 SDK 자동 fallback + Discord 알림 (선택)

## 최종 검증

- [ ] `pnpm test` (mock-only) 전체 통과, 회귀 0
- [ ] `pnpm test:live -- providers/claude-cli` 통과 (live 환경)
- [ ] `pnpm typecheck` 0 에러
- [ ] `pnpm lint` 0 위반
- [ ] git diff 검토 — 변경 외 무관 라인 없음 (CLAUDE.md §3 외과적 변경)
- [ ] `plans/phase32/review.md` 작성 — 정책 결정 6건 결과 + Max 1주 실사용 후 cost/limit 보고
- [ ] CLAUDE.md 변경 이력 추가 (선택)

## 메모

- **OpenClaw 가져온 코드 출처**:
  - cli-backends: `/mnt/c/Users/박/Desktop/hi/openclaw/src/agents/cli-backends.ts:36-95`
  - cli-runner core: `/mnt/c/Users/박/Desktop/hi/openclaw/src/agents/cli-runner.ts:35-359`
  - reliability: `/mnt/c/Users/박/Desktop/hi/openclaw/src/agents/cli-runner/reliability.ts:1-80`
  - queue (enqueueCliRun): `/mnt/c/Users/박/Desktop/hi/openclaw/src/agents/cli-runner/helpers.ts:24-40`
- **사용자 컨텍스트**: Claude Max 구독자 → API 비용 0원 전환이 본 Phase 의 단일 동기. Pro 구독자라면 rate limit 위험으로 권고하지 않음.
- **트레이드오프**: streaming/caching/tool_use 일부 제약 — `plan.md` "트레이드오프" 섹션 참조.
- **Phase 31 의존**: 없음. Phase 31 완료 전이라도 본 Phase 진행 가능 (각자 독립).
