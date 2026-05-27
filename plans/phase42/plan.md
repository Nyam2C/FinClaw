# Phase 42 plan — 기초 검증 + 재설계 그라운드워크

> `kickoff.md` 의 검증 백로그(SUMMARY P0/P1/dead)와 별개로, **재설계 축의 구체 결정**을 여기에 기록한다.
> 진행 원칙: 의존 바텀업 읽기 순서(`types` → `infra` → … → `agent` → `server`)에 맞춘 **type-first**. reader 배선은 해당 레이어 도달 시 (orphan 금지 — `todo.md` 가 추적).

---

## 결정 1 — `AgentProfile` 부활: orchestrator-worker 워커 정의 (type-first)

### 배경 (검증 완료)

- `AgentProfile` (`packages/types/src/agent.ts:4`) = **dead-on-arrival**. 정의 이래 소비자 0 (grep=1), git pickaxe 3커밋 전부 비사용(정의·monorepo 이동·문서).
- 죽은 이유: FinClaw 가 **단일 에이전트 + 글로벌 `systemPrompt`/`skills` + 하드코딩 `maxConcurrent:1`** 이라 per-agent 프로필이 불필요했음.
- **제거 대신 살린다.** 명분 = 보류 중인 **orchestrator-worker 라우터**의 "워커 정의" 타입 (워커마다 다른 프롬프트·모델·도구·동시성 필요). 단일 → 멀티 워커로 가는 순간 이 타입이 소비자를 얻는다.

### 설계 원칙

> **런타임 가변 운영 노브 → `interface` (즉시 변경) · 무겁고 구조적인 정의 → `agentDir` 파일.**

- 동기: 로드맵 난제 "요청당 N+1 spawn 구독 쿼터 비용" → **쿼터 압박 시 워커 동시성·모델을 파일 안 고치고 즉시 조절**해야 함 ("언제든 변경가능" = 사용자 결정).
- 정적 정의(프롬프트 본문·도구 허용목록)는 `.claude/agents/*.md` 패턴처럼 파일로.

### 필드 disposition

| 필드                 | 위치                                                   | 사유                                                                      |
| -------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `id`, `name`         | interface                                              | 정체성 (레지스트리 키/라벨)                                               |
| `model` (`ModelRef`) | interface                                              | 런타임 가변 — 쿼터 압박 시 opus→sonnet 즉시 강등                          |
| `maxConcurrent`      | interface                                              | 런타임 가변 — 워커 동시성 throttling. `key=agentId` 면 "이 워커 동시 N개" |
| `agentDir`           | interface (포인터, **required 승격**)                  | 정적 정의 파일 폴더를 가리킴                                              |
| ~~`systemPrompt`~~   | → `agentDir` 정의 파일 **body**                        | 무거운 텍스트, 숫자처럼 못 바꿈                                           |
| ~~`skills`~~         | → `agentDir` 정의 파일 **frontmatter** (도구 허용목록) | 구조적·보안성. (라이브 권한조정 원하면 추후 interface 승격 재고)          |

### 결과 타입 (적용됨 — `agent.ts`)

```ts
interface AgentProfile {
  id: AgentId;
  name: string;
  model: ModelRef; // 런타임 가변
  maxConcurrent: number; // 런타임 가변
  agentDir: string; // -> 정의 파일: body=systemPrompt, frontmatter=skills 허용목록
}
```

### deferred — reader 단계 (해당 레이어 도달 시. `todo.md` 가 추적)

1. **`agentDir` 정의 로더** — 폴더 읽기 + frontmatter 파싱 + prompt body 로드 + skill 허용목록 해석. (현재 `agentDir` 값은 아무도 역참조 안 함 — 전부 신규)
2. **per-worker 도구 스코핑 집행** (Seam 3, 신규 레이어) — 오늘 도구 게이팅은 100% 호스트 전역(MCP `--allowedTools` + bridge 필터). 워커별 허용목록 차단부 필요.
3. **`maxConcurrent` 런타임 가변 경로** — (a) config reload vs (b) 라이브 RPC 변경. `ConcurrencyLane` 을 `key=agentId` 로 acquire (선례: `gateway/.../agent.ts:245` `agentRunLane.acquire(agentId)`; 잠든 `subagent` 레인 cap 3 활용).
4. **`model` 런타임 가변** — 워커 spawn 시 프로필 model 주입 (선례: `analyze_market` opus per-call).
5. **`binding-matcher` 라우팅 자격 신호 새 집** — 현재 `if (entry.agentDir)` presence-gate 가 agentDir required 되면 붕괴(전부 통과). 라우팅 자격은 별 신호로.
6. **`AgentProfile` ↔ `AgentEntry`(config) reconcile + resolver** — `config.ts:91` `AgentEntry` + `AgentsConfig.entries: Record<string, AgentEntry>` 가 이미 워커 레지스트리 골격. config(선언) → resolve → AgentProfile(런타임).
7. **`provider` 사문화 필드 정리** — `AgentEntry.provider`/`AgentDefaultsConfig.provider`/`ModelRef.provider` 는 Claude-CLI 단일 후 의미 퇴색. 별도 판단 (지금 건드리지 않음).
8. **delegate 진입점** (Seam 5) — `analyze_market` 하드코딩 클로저(`skills-finance/.../news/index.ts:104`)를 "프로필 받아 spawn"으로 일반화. = orchestrator-worker **기능 phase** (groundwork 아님).

### 주의 / 미결

- 이 결정은 **타입 토대만** (사용자 결정). reader(1~8)는 후속. 타입은 단순해지나 복잡도는 "로더+포맷+집행"으로 **이전**됨 (소멸 아님).
- `AgentProfile` 은 dead 였으므로 필드 제거는 회귀 위험 0 (소비자 0 검증).
