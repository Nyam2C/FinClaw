# Verifier Report

검증 방식: main agent 가 직접 grep / read 로 핵심 사실 대조 (sub-agent quota 한도로 verifier 에이전트 spawn 생략).

## 요약

- 검증 항목: 12 (high priority)
- 사실 오류: 1 (수정 완료)
- 누락: 0
- 모호: 0

## 사실 오류

### E1. RPC 메서드 총 개수

- **README 위치:** "Gateway JSON-RPC (38 개 메서드)"
- **검증:** grep `method:` 로 각 파일 카운트
  - system: 3 (`system.ts:17,41,58`)
  - config: 3 (`config.ts:9,25,41`)
  - chat: 4 (`chat.ts:49,78,135,150`)
  - session: 3 (`session.ts:40,56,74`)
  - agent: 3 (`agent.ts:162,182,217`)
  - agent.runs: 2 (`agent-runs.ts:45,86`)
  - memory: 3 (`memory.ts:116,140,168`)
  - finance: 9 (`finance.ts:198,228,264,309,351,409,467,508,555`)
  - schedule: 9 (`schedule.ts:108,149,177,239,252,265,312,327,355`)
  - **총 39 개**
- **권장 수정:** 38 → 39
- **상태:** 수정 완료

## 검증 통과 (High Priority)

| 주장                                                              | SoT                                                                                                 | 결과              |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------- |
| Node.js >= 22.0.0                                                 | `package.json` `engines.node`                                                                       | ✓                 |
| pnpm 10.4.1                                                       | `package.json` `packageManager`                                                                     | ✓                 |
| 11 패키지                                                         | `ls packages/` + `tsconfig.json` references count                                                   | ✓ (11 references) |
| `pnpm build` = `tsc --build`                                      | `package.json` scripts                                                                              | ✓                 |
| `pnpm dev` = `tsx packages/server/src/main.ts`                    | `package.json` scripts                                                                              | ✓                 |
| 필수 env 3개 (ANTHROPIC/DISCORD_BOT_TOKEN/DISCORD_APPLICATION_ID) | `main.ts:141-143` requireEnv 호출                                                                   | ✓                 |
| `MissingEnvError` 후 `process.exit(1)`                            | `main.ts:97-114, 507-520`                                                                           | ✓                 |
| `FINCLAW_API_KEY` 단일 키                                         | `main.ts:379` (`apiKeys: KEY ? [KEY] : []`)                                                         | ✓                 |
| `GATEWAY_PORT` 기본 3000                                          | `main.ts:145-150`                                                                                   | ✓                 |
| `AUTOMATION_MAX_CONSECUTIVE_FAILURES` 기본 3                      | `main.ts:417`, `scheduler.ts:61`                                                                    | ✓                 |
| 파이프라인 8 단계                                                 | `pipeline.ts` 의 normalize/command/memoryCapture/ack/context/memoryRetrieval/execute/deliver 6+2 콜 | ✓                 |
| `SCHEMA_VERSION = 6`                                              | `database.ts:21`                                                                                    | ✓                 |
| `.env.example` 존재                                               | `ls .env.example`                                                                                   | ✓                 |
| `config.example.json5` 존재                                       | `ls config.example.json5`                                                                           | ✓                 |
| `extensions/plugin-template/` 존재                                | `ls extensions/`                                                                                    | ✓                 |
| Voyage/OpenAI 임베딩 fallback                                     | `main.ts:199-211`, `embeddings/openai.ts:11-15`                                                     | ✓                 |
| schedule 9 메서드                                                 | `schedule.ts:386-394` registerMethod 9 회 호출                                                      | ✓                 |

## 비검증 / 의도적 제외

- 외부 API (Alpha Vantage, CoinGecko, Voyage) 의 실제 호출 — `test:live` 영역.
- `finclaw.json5` 의 zod-schema 모든 필드 - 본 README 에서는 섹션 단위 테이블만 나열.
- mermaid 다이어그램의 모든 노드명 — 패키지 의존 그래프와 sequenceDiagram 의 노드명은 위 11 패키지 + 표준 컴포넌트라 인라인 검증 불요.

## 메타데이터

- 검증 도구: `grep`, `wc -l`, `ls`, `Read`
- 검증자: main agent (sub-agent quota 한도로 readme-verifier 에이전트 직접 spawn 생략)
