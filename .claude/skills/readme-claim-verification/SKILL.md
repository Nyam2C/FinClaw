---
name: readme-claim-verification
description: README 초안의 검증 가능한 주장을 코드 진실과 1:1 대조하는 방법론. readme-verifier 가 반드시 참조. 주장 분류(검증가능/의견), source-of-truth 매핑, 검증 도구(grep, read, ls), 누락 탐지(역방향 검증), 보고 형식 표준화.
---

# README Claim Verification

verifier 가 README 사실성을 검증할 때 따르는 표준 방법론.

## 1. 주장 분류

| 유형      | 예시                                                   | 검증?                           |
| --------- | ------------------------------------------------------ | ------------------------------- |
| 검증 가능 | "Node.js >= 22.0.0", "`pnpm dev` 실행", "11 개 패키지" | ✅ 필수                         |
| 의견      | "사용하기 쉽다", "빠르다"                              | ❌ 건드리지 않음                |
| 마케팅    | "최첨단", "혁신적"                                     | ❌ author 가 톤 규약으로 처리   |
| 추측성    | "확장 가능할 것이다"                                   | ⚠️ author 에 보고하여 삭제 권장 |

## 2. Source of Truth 매핑

각 주장 유형마다 SoT 파일이 정해진다. SoT 가 아닌 곳에서 검증하지 않는다.

| 주장 유형           | SoT (1 차)                                                                               | SoT (교차 검증)                                           |
| ------------------- | ---------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| 명령어 (`pnpm xxx`) | 루트 `package.json` `scripts`                                                            | `scripts/*.sh`, `*.mjs`                                   |
| Node 버전           | 루트 `package.json` `engines`                                                            | `.node-version`                                           |
| pnpm 버전           | 루트 `package.json` `packageManager`                                                     | `pnpm-lock.yaml` 헤더                                     |
| 패키지 목록         | `pnpm-workspace.yaml` + `packages/*/package.json` 의 `name`                              | `tsconfig.json` references                                |
| 패키지 의존         | 각 `packages/*/package.json` `dependencies`                                              | `tsconfig.json` references                                |
| 환경변수 (런타임)   | `packages/infra/src/env.ts` 또는 `process.env` 사용처                                    | `.env.example`, `packages/config/src/zod-schema.ts`       |
| 환경변수 (config)   | `packages/config/src/zod-schema.ts`                                                      | `config.example.json5`, `packages/config/src/defaults.ts` |
| 포트                | 환경변수 기본값 또는 `packages/server/src/gateway/` 의 listen 호출                       | `docker-compose.yml` ports                                |
| RPC 메서드          | `packages/server/src/gateway/rpc/methods/*` 의 등록 코드                                 | `packages/types/src/gateway.ts`                           |
| 스킬 등록           | `packages/skills-finance/src/index.ts`, `packages/skills-general/src/index.ts` 의 export | 각 스킬 정의 파일                                         |
| 채널 등록           | `packages/server/src/channels/` registry                                                 | `packages/channel-discord/src/index.ts`                   |
| 파이프라인 스테이지 | `packages/server/src/auto-reply/pipeline.ts` 의 등록 순서                                | `packages/server/src/auto-reply/stages/`                  |
| Docker 사용법       | `Dockerfile` + `docker-compose.yml`                                                      | scripts/                                                  |
| 테스트 명령         | `package.json` scripts + `vitest*.config.ts`                                             | `scripts/test-parallel.mjs`                               |
| lefthook hooks      | `lefthook.yml`                                                                           | `.lefthookrc`                                             |

## 3. 검증 도구

### 파일 존재

```bash
ls path/to/file
test -f path/to/file && echo OK
```

### 파일 내용 grep

```bash
grep -n "MemoryCaptureStage" packages/server/src/auto-reply/pipeline.ts
```

### 환경변수 사용처 역추적

```bash
grep -rn "process.env.X" packages/ --include="*.ts"
```

### 패키지 이름 ↔ 디렉토리 매핑

```bash
for f in packages/*/package.json; do
  echo "=== $f"
  grep -E '"name":' "$f"
done
```

### mermaid 노드 이름이 실제 패키지인가

mermaid 다이어그램의 각 노드명을 추출 → 위 패키지 이름 목록과 대조.

## 4. 역방향 검증 (누락 탐지)

README 에 있는 것만 검증하지 말고, 코드에는 있는데 README 에 없는 것을 찾아내는 것이 핵심:

| 질문                                | 검증 절차                                                                              |
| ----------------------------------- | -------------------------------------------------------------------------------------- |
| README 에 빠진 환경변수가 있는가?   | `grep -rn "process.env\." packages/ --include="*.ts"` 결과를 README 환경변수 표와 대조 |
| README 에 빠진 패키지가 있는가?     | `ls packages/` 와 README 패키지 표 대조                                                |
| README 에 빠진 명령어가 있는가?     | `package.json` scripts 와 README 명령어 표 대조                                        |
| README 에 빠진 채널이 있는가?       | `packages/channel-*` 디렉토리와 README 대조                                            |
| README 에 빠진 RPC 메서드가 있는가? | `packages/server/src/gateway/rpc/methods/` 의 export 와 README 대조                    |

## 5. 검증 보고 형식

각 발견은 다음 구조로 보고:

```markdown
### E{번호}. {짧은 한 줄 제목}

- **README 위치:** {섹션명, 인용 1~2 줄}
- **주장:** {정확히 무엇을 주장했는가}
- **검증:** {grep / read / ls 결과 — 파일:라인 인용}
- **권장 수정:** {구체적인 대체 텍스트 또는 삭제/추가 지시}
```

분류 코드:

- `E` = Error (사실 오류, author 반드시 수정)
- `M` = Missing (누락, author 추가 권장)
- `A` = Ambiguous (모호, author 판단 필요)
- `P` = Pass (검증 통과, 별도 조치 없음 — 요약 통계용)

## 6. 검증 우선순위

1. **High:** 명령어, 환경변수, 패키지명, 파일 경로 — 잘못되면 사용자가 즉시 막힌다.
2. **Medium:** 의존 그래프, 데이터 흐름 다이어그램 — 신뢰도에 영향.
3. **Low:** 카테고리 분류, 표현의 정확성.

시간/문맥 한계 시 High 부터 처리.

## 7. 검증 제외

- 외부 호출 (Docker 빌드 실제 실행, API 호출, npm install 검증) — 메모리/문서 증거만 활용.
- 주관적 표현 ("쉽다", "빠르다").
- 미래 시제 / 계획 ("Phase 27 에서 추가 예정") — 코드에 없는 게 정상.
- 메모리 / CLAUDE.md 의 사용자 메타정보 (이메일, 환경 메모) — README 에 들어가지 않음.

## 8. 흔한 오류 패턴

- **Outdated 패키지 수:** README 가 "10 개 패키지" 라고 했는데 실제로는 11 개 (또는 그 반대).
- **이름 변경된 환경변수:** `FINCLAW_DATA_PATH` → `FINCLAW_DB_PATH` 류.
- **삭제된 명령어:** 옛 phase 의 잔존 명령어가 README 에 남음.
- **Mermaid 노드 누락:** 패키지 11 개 중 10 개만 그래프에 표시.
- **포트 불일치:** README 가 `3000` 인데 docker-compose 는 `3001`.
- **테스트 tier 명칭 불일치:** `pnpm test:integration` 같은 존재하지 않는 명령.
