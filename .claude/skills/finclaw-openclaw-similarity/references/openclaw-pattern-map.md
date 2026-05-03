# OpenClaw 핵심 모듈 인덱스 (4축 매핑 시작점)

이 문서는 4 comparator 가 비교 작업을 시작할 때 어디를 먼저 읽어야 하는지의 인덱스다. **고정된 매핑이 아니라 출발점**이다 — comparator 는 직접 코드를 읽고 추가 모듈을 발견·매핑해야 한다.

## OpenClaw 레포 위치

```
/mnt/c/Users/박/Desktop/hi/openclaw/
```

## 전체 구조 요약

```
openclaw/
├── package.json          # bin: openclaw.mjs, type: module, build: tsdown + scripts/*.ts
├── pnpm-workspace.yaml   # packages: [., ui, packages/*, extensions/*]
├── openclaw.mjs          # CLI 진입점
├── src/                  # 27 MB — 거의 모든 도메인이 여기 있음
├── apps/                 # ios/android/macos/shared (모바일 앱; 평가 비대상)
├── ui/                   # 1.8 MB — 별도 UI
├── extensions/           # 4.9 MB — 핵심 확장 (별도 vitest config 존재)
├── skills/               # 80+ 외부 도메인 스킬 (1password, github, gemini, ...)
├── packages/             # 워크스페이스 패키지 (clawdbot, moltbot)
└── vitest.{unit,e2e,extensions,gateway,live}.config.ts  # 5+ 티어 테스트
```

## 축 A: 아키텍처 / 패키지 / 빌드

**OpenClaw 핵심 진입점/구조:**

- `package.json` — bin, exports(plugin-sdk 등), scripts(빌드 단계 다수)
- `pnpm-workspace.yaml` — 단일 루트 + packages/_ + extensions/_ + ui
- `openclaw.mjs` — CLI 진입점
- `src/index.ts`, `src/entry.ts`, `src/globals.ts` — 모듈 진입점
- `src/daemon/` — 데몬 프로세스 모델
- `src/process/` — 프로세스 관리
- `src/sessions/` — 세션 라이프사이클
- `tsdown.config.ts`, `tsconfig.plugin-sdk.dts.json` — 빌드 시스템
- `Dockerfile`, `Dockerfile.sandbox*` — 다중 컨테이너 모델
- `fly.toml`, `render.yaml` — 배포 모델
- `vitest.{unit,e2e,extensions,gateway,live}.config.ts` — 5 티어 테스트

**FinClaw 대응 시작점:**

- `packages/` (11 패키지)
- `pnpm-workspace.yaml`, `tsconfig.base.json`
- `packages/server/src/main.ts`
- `vitest.{config,e2e,storage,live}.config.ts` — 4 티어

비교 포인트: 단일 모놀리식 src/ vs 11 패키지 분할. 빌드 단순도. plugin-sdk 의 dts 분리 빌드 vs FinClaw 의 project references.

## 축 B: 런타임 / Agent / Tool / Skill / Provider

**OpenClaw 핵심:**

- `src/agents/` — 100+ 파일. 핵심:
  - `context.ts`, `compaction.ts`, `context-window-guard.ts` — 토큰/컨텍스트 관리
  - `bash-tools.exec.ts` 외 다수 — pty 기반 bash 도구
  - `apply-patch.ts` — 자기-편집 도구 (Letta 류)
  - `cache-trace.ts` — 프롬프트 캐싱 추적
  - `auth-profiles.ts`, `auth-profiles/` — 다중 backend 인증 프로파일
  - `claude-cli-runner.ts` — Claude Code CLI 를 backend 로 사용
  - `cli-backends.ts`, `cli-runner/` — 모델 backend 추상화
  - `chutes-oauth.ts`, `cloudflare-ai-gateway.ts`, `bedrock-discovery.ts`, `byteplus-*`, `huggingface-models.ts`, `minimax-vlm.ts` — 다중 프로바이더
  - `image-sanitization.ts`, `content-blocks.ts` — 멀티모달
  - `failover-error.ts`, `command-poll-backoff.ts` — 에러 회복
- `src/auto-reply/` — 채널 메시지 → 응답 파이프라인
- `src/providers/` — 모델 프로바이더 어댑터
- `src/routing/` — 라우팅
- `src/hooks/` — 훅 시스템
- `src/plugins/`, `src/plugin-sdk/` — 플러그인 시스템
- `skills/` — 외부 도메인 스킬 (1password, github, gemini, ...) 80+

**FinClaw 대응 시작점:**

- `packages/agent/src/{execution,agents,providers}/`
- `packages/agent/src/prompts/finance-context.ts`
- `packages/server/src/auto-reply/stages/`
- `packages/skills-{finance,general}/src/`

비교 포인트: agent loop 충실도, 도구 추상화, 프로바이더 다중성, 스킬 디스커버리, plugin-sdk 부재 의도성, claude-cli-runner 같은 backend-as-cli 패턴 부재.

## 축 C: Memory / Knowledge / RAG / Storage

**OpenClaw 핵심:**

- `src/memory/` — 메모리 시스템
- `src/agents/memory-search.ts`, `src/agents/compaction.ts` — 토큰 한계 압축
- `src/agents/context.ts` — 컨텍스트 빌더
- `src/sessions/` — 세션 영속화
- (SQLite 사용 여부, 임베딩 파이프라인 — comparator 가 직접 확인)
- `src/link-understanding/`, `src/media-understanding/` — 멀티모달 인덱싱

**FinClaw 대응 시작점:**

- `packages/storage/src/{database,tables,embeddings,search,memories,transactions,agent-runs,portfolio-holdings}.ts`
- `packages/server/src/auto-reply/stages/{memory-capture,memory-retrieval,context}.ts`
- `packages/agent/src/agents/context/`

비교 포인트: 자기-편집 메모리(MemGPT) 패턴, compaction, RAG 주입 위치, 임베딩 모델 선택, 토큰 회계.

## 축 D: Interface / Channels / Gateway / UI

**OpenClaw 핵심:**

- `src/channels/`, `src/discord/`, `src/slack/`, `src/telegram/`, `src/whatsapp/`, `src/imessage/`, `src/line/`, `src/signal/` — 8+ 채널
- `src/gateway/` — 게이트웨이
- `src/acp/` — ACP 프로토콜 (docs.acp.md)
- `src/canvas-host/` — Canvas (ChatGPT Canvas / Claude Artifacts 류)
- `src/cron/` — 스케줄러
- `src/cli/`, `src/tui/`, `src/terminal/` — TUI/CLI
- `src/web/` — Web UI
- `src/wizard/`, `src/pairing/` — 온보딩
- `src/security/` — 인증/권한
- `src/logging/` — 운영 로깅
- `src/markdown/`, `src/tts/`, `src/media/` — 출력 형식
- `extensions/` — 확장 시스템

**FinClaw 대응 시작점:**

- `packages/server/src/channels/`
- `packages/channel-discord/src/`
- `packages/server/src/gateway/{rpc,websocket,openai-compat,auth}/`
- `packages/server/src/automation/{scheduler,cron,delivery}.ts`
- `packages/tui/src/`, `packages/web/src/`
- `packages/server/src/plugins/` (있다면)

비교 포인트: 채널 다양성(8+ vs 1~3), Canvas/Artifacts 부재, ACP 부재, MCP 부재, 인증 깊이, automation 신뢰성, UI 풍부도.

## 비교 작업 우선순위

각 comparator 는 다음 순서로:

1. **본질 추출** — OpenClaw 측 진입점/핵심 모듈을 읽고 패턴 카탈로그 작성 (10~20 항목)
2. **FinClaw 매핑** — 각 패턴에 대해 FinClaw 의 대응을 grep/find 로 검색
3. **라벨링** — comparison-rubric.md 의 5 라벨 적용
4. **본질성 부여** — Critical/Important/Nice-to-have
5. **유사도 점수 계산** — 가중 평균
6. **출력** — `_workspace/openclaw-similarity/{영역}.md`

## 비교 작업의 함정 (피할 것)

- ❌ **명칭 일치를 패턴 일치로 오인** — `auto-reply` 폴더가 양쪽에 있다고 Faithful 이라 단정하지 말 것. stage 분리 방식, 파일 수, 의존성을 봐야 함.
- ❌ **누락을 자동으로 Adapted 로 분류** — "사용자 1인용이니까 다중 채널 누락은 Adapted" 가 아니다. 누락이 사용자 가치를 떨어뜨리면 Missing.
- ❌ **OpenClaw 의 모든 패턴을 모방 대상으로 가정** — OpenClaw 에도 over-engineering 이 있을 수 있다. FinClaw 가 의도적으로 안 가져왔으면 Diverged 로 분류 가능.
- ❌ **OpenClaw 측을 "있다/없다" 만 점검** — OpenClaw 의 코드 품질·구조도 함께 평가해야 비교가 의미 있다.
