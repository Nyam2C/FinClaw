# Phase 42 todo — 기초 검증 + 재설계 그라운드워크

> 결정 근거·설계는 `plan.md` 참조. 여기는 실행 체크리스트.

## AgentProfile 부활 (type-first)

### 완료 (types 레이어)

- [x] `AgentProfile` 수정 (`packages/types/src/agent.ts`): `systemPrompt`·`skills` 제거, `agentDir` required 승격, `{ id, name, model, maxConcurrent, agentDir }` 로 축소 + 설계 doc 주석.

### deferred — reader 레이어 도달 시 (orphan 금지, `[]` 안은 예상 레이어)

- [ ] `agentDir` 정의 로더 — 정의 파일 frontmatter(skills 허용목록·meta) + body(systemPrompt) 파싱·로드 `[server/agent]`
- [ ] per-worker 도구 스코핑 집행 — skills 허용목록대로 도구 차단 (Seam 3, 신규 레이어) `[agent/gateway]`
- [ ] `maxConcurrent` 런타임 가변 경로 + `ConcurrencyLane` `key=agentId` 배선 (잠든 `subagent` 레인 cap 3 활용) `[infra/agent]`
- [ ] `model` 런타임 가변 — 워커 spawn 에 프로필 model 주입 `[agent]`
- [ ] `binding-matcher` 라우팅 자격 신호 새 집 (agentDir presence-gate 대체) `[server]`
- [ ] `AgentProfile` ↔ `AgentEntry`(config) reconcile + resolver (config→profile) `[types/config]`
- [ ] `provider` 사문화 필드 정리 판단 `[config]`
- [ ] delegate 진입점 — `analyze_market` 클로저 일반화 (orchestrator-worker 기능 phase) `[기능 phase]`

## (기존) 검증 백로그 — kickoff.md P0/P1/dead

> SUMMARY 주장 직접 대조는 `kickoff.md` 표 참조. 착수 시 여기로 단계 분해.
