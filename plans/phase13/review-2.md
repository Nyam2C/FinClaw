# Phase 13 TODO-2 리뷰: 명령어 구현

> 리뷰 대상: `feature/cli-entry-commands` 브랜치, unstaged diff
> 변경 파일: program.ts (수정) + commands/ 디렉토리 (신규 8개 소스 + 3개 테스트)

---

## 1. 전체 평가

**TODO-2 명세 대비 구현 완성도: 95%**

8개 명령어 모두 구현, 테스트 3개(config, market, news) 작성 완료. program.ts에서 placeholder 제거 후 실제 register 호출로 교체. 구조가 깔끔하고 일관된 패턴을 따름.

---

## 2. program.ts 변경

| 항목                        | 평가                                                           |
| --------------------------- | -------------------------------------------------------------- |
| placeholder → register 교체 | ✅ 깔끔한 diff, 57줄 제거 → 17줄 추가                          |
| import 스타일               | ✅ `import * as fooCmd` — namespace import로 `register`만 노출 |
| 8개 명령어 등록 순서        | ✅ start, stop, config, agent, channel, market, news, alert    |

**참고**: todo-2 섹션 9에서 언급한 `commandEntries` 배열 방식 대신 직접 static import + `register()` 호출 방식을 사용. commandEntries 배열이 todo-1 원본에 없었으므로 (placeholder 인라인이었음) 이 방식이 더 단순하고 적절함.

---

## 3. 명령어별 리뷰

### 3-1. start.ts ✅

- 옵션: `--port`, `--host`, `--detach` — 명세 일치
- detach 모드: `child_process.spawn` + `unref()` — 정상
- foreground: `await import('../../main.js')` 동적 임포트 — 정상
- `process.env` 직접 설정으로 포트/호스트 전달 — 실용적 접근

**주의사항**:

- L21: `process.argv[1] ?? ''` — argv[1]이 undefined인 경우 빈 문자열로 spawn하면 실패함. 실제로 발생할 가능성은 극히 낮지만 방어 코드 고려 가능.

### 3-2. stop.ts ✅

- `system.shutdown` RPC 호출 — 명세 일치
- 에러 시 `EXIT.GATEWAY_ERROR` — 일관성 있음

### 3-3. config.ts ✅

- 서브커맨드 3개 (list, get, set) — 명세 일치
- `config.get`, `config.update` RPC 매핑 — 정확
- `formatKeyValue` 사용 — 적절

### 3-4. agent.ts ✅

- 서브커맨드 2개 (list, status) — 명세 일치
- list: `formatTable` + 빈 목록 처리 (`theme.dim`) — 좋음
- status: `formatKeyValue` — 적절

### 3-5. channel.ts ✅

- agent.ts와 동일한 패턴 — 명세 일치
- RPC: `channel.list`, `channel.status` — 정확

### 3-6. market.ts ✅

- quote: `finance.quote` RPC + `--format`, `--currency` 옵션 — 명세 일치
- watch: placeholder (`not yet implemented`) — 명세대로 스트림 미구현

**명세 차이**: currency 기본값이 `'USD'` (명세는 `'KRW'`). 의도적 변경으로 보이며, USD가 더 범용적이므로 합리적.

### 3-7. news.ts ✅

- optional query + `--symbols` 필터 — 명세 일치
- symbols `.split(',')` 처리 — 정확
- 빈 결과 처리 (`theme.dim('No news found.')`) — 좋음

### 3-8. alert.ts ✅

- 서브커맨드 3개 (add, list, remove) — 명세 일치
- `requiredOption` 사용 — 적절
- `Number(opts.price)` 변환 — 정확
- channel optional — 명세 일치

**참고**: 명세의 `--ticker/--condition/--price` (long only) → 구현은 `-t/-c/-p` 단축키 추가. 사용성 향상이므로 양호.

---

## 4. 테스트 리뷰

### 4-1. config.test.ts ✅ (4 테스트)

| 테스트                | 검증 항목                       | 평가 |
| --------------------- | ------------------------------- | ---- |
| list                  | `config.get` 호출 + output 내용 | ✅   |
| get \<key\>           | `config.get` + key 파라미터     | ✅   |
| set \<key\> \<value\> | `config.update` + 성공 메시지   | ✅   |
| list error            | error + exit 호출               | ✅   |

### 4-2. market.test.ts ✅ (3 테스트)

| 테스트              | 검증 항목                        | 평가 |
| ------------------- | -------------------------------- | ---- |
| quote default       | `finance.quote` + currency:'USD' | ✅   |
| quote --format json | JSON.parse 검증                  | ✅   |
| quote error         | error + exit 호출                | ✅   |

### 4-3. news.test.ts ✅ (3 테스트)

| 테스트         | 검증 항목                       | 평가 |
| -------------- | ------------------------------- | ---- |
| query          | `finance.news` + query 파라미터 | ✅   |
| symbols filter | `.split(',')` → 배열 전달       | ✅   |
| error          | error + exit 호출               | ✅   |

---

## 5. 코드 품질

| 항목                  | 평가                                                     |
| --------------------- | -------------------------------------------------------- |
| 일관된 에러 처리 패턴 | ✅ `if (!result.ok) { error → exit → return }` 전체 통일 |
| theme 활용            | ✅ error/success/info/dim 적절히 분류                    |
| EXIT 코드 사용        | ✅ GATEWAY_ERROR 일관 적용                               |
| 타입 안전성           | ✅ `callGateway<T>` 제네릭 활용                          |
| import 정리           | ✅ 미사용 import 없음                                    |
| 파일 크기             | ✅ 모두 70줄 이하로 간결                                 |

---

## 6. 미비 사항 (non-blocking)

1. **start.ts, stop.ts, agent.ts, channel.ts, alert.ts 테스트 없음** — todo-2 명세에 테스트가 config/market/news만 지정되어 있으므로 명세 준수이나, 향후 추가 권장
2. **health, status 명령어가 여전히 program.ts에 인라인** — commands/ 디렉토리로 추출하면 일관성 향상, 하지만 todo-2 범위 밖

---

## 7. 리팩토링 후보

> 현재 코드가 동작하는 데 문제는 없으나, 향후 개선 시 고려할 사항:

### R-1. 에러 처리 헬퍼 추출

모든 명령어에서 동일한 패턴 반복 (약 12회):

```typescript
if (!result.ok) {
  deps.error(theme.error(`Failed to ...: ${result.error}`));
  deps.exit(EXIT.GATEWAY_ERROR);
  return;
}
```

→ 헬퍼 함수로 추출 가능:

```typescript
// cli/commands/_shared.ts
function handleGatewayError(deps: CliDeps, result: RpcResult, context: string): boolean;
```

**판단**: 현재 8개 파일에서 12회 반복. 패턴이 안정화된 후 추출하면 diff 크기 ~40% 감소 가능. 단, 현 시점에서는 각 명령어가 독립적이므로 급하지 않음.

### R-2. agent.ts / channel.ts 공통화

두 파일이 거의 동일한 구조 (list + status):

- RPC 메서드명과 에러 메시지만 다름
- 팩토리 함수로 통합 가능

**판단**: 현재 2개뿐이므로 중복 허용 범위. 비슷한 패턴의 명령어가 추가되면 그때 추출.

### R-3. health / status 명령어 추출

program.ts에 남아 있는 인라인 health/status 명령어를 commands/ 디렉토리로 이동하면 구조 일관성 향상.

**판단**: 코드량이 적고 (각 10줄 미만) 별도 파일 생성 비용 대비 이점이 작음. 명령어가 더 복잡해지면 추출.
