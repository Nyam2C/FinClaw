# Phase 1 Review

Phase 1 todo.md (T1-T7) 구현 완료 후, 스펙 대비 정합성 리뷰 결과.

## 1. 작업별 준수 여부 (T1-T7)

| 작업 | 판정            | 비고                                                                                                       |
| ---- | --------------- | ---------------------------------------------------------------------------------------------------------- |
| T1   | PASS            | `AsyncDisposable` → `CleanupFn` 리네이밍 + JSDoc 갱신 완료                                                 |
| T2   | PASS            | `ErrorReason`(7종) + `FinClawError` 인터페이스 추가 완료                                                   |
| T3   | PASS            | `ConfigIoDeps` 5메서드 추가, `LogLevel` 직접 참조 (todo.md §T3 "더 단순함" 지침 준수)                      |
| T4   | PASS            | import + 시그니처 3곳 모두 `CleanupFn`으로 교체                                                            |
| T5   | PASS            | barrel export 24줄, `export type *` 10개 + 런타임 값 3개 블록                                              |
| T6   | PASS (1건 편차) | 4개 테스트 파일 작성. `Brand` import 제거는 todo.md 스펙에 없으나 oxlint `no-unused-vars` 준수를 위해 필요 |
| T7   | PASS            | typecheck 0, build OK, test 34/34, lint 0                                                                  |

## 2. diff 요약 (변경 파일 8개)

수정 4개:

- `src/common.ts`: +23줄 (CleanupFn 리네이밍 +4, ErrorReason/FinClawError +19)
- `src/config.ts`: +14줄 (ConfigIoDeps)
- `src/channel.ts`: ±0줄 (치환 3곳)
- `src/index.ts`: +22줄 (전체 교체)

신규 4개:

- `test/config.test.ts`: 63줄, 6 tests
- `test/message.test.ts`: 84줄, 10 tests
- `test/finance.test.ts`: 43줄, 8 tests
- `test/type-safety.test.ts`: 73줄, 9 tests

## 3. 잔존 확인

- `AsyncDisposable` 타입 참조: 0건 (JSDoc 코멘트 1건은 리네이밍 사유 설명이므로 정상)
- `TODO = 'stub'` in `packages/types/src/`: 0건 (다른 패키지 6개에는 Phase 0 스텁 잔존 — Phase 1 범위 밖)
- `dist/index.d.ts`: 존재 확인

## 4. 스펙 편차 (1건)

`type-safety.test.ts`에서 `Brand` import 제거:

- todo.md 스펙에는 `Brand`가 import 목록에 포함되어 있으나, 실제 테스트 코드에서 사용하지 않음
- oxlint `no-unused-vars` 위반으로 lint 실패 → import 제거로 해결
- 판정: 정당한 편차 (스펙 오류 수정)

## 5. 발견된 리팩토링 후보 (향후 참고)

현 Phase에서는 조치 불필요. 필요 시점에 재검토.

- **R1**: `createTickerSymbol`의 `.toUpperCase().trim()` 호출 순서
  - 현재: `symbol.toUpperCase().trim()` — 대문자 변환 후 trim
  - 관례적 순서: `symbol.trim().toUpperCase()` — 정제 후 변환
  - 결과는 동일하지만 의도 표현이 더 명확해짐
  - 심각도: 낮음 (동작 동등, 순수 가독성)

- **R2**: `createTickerSymbol`의 입력 검증 부재
  - `createCurrencyCode`는 형식 검증(3글자 알파벳) 후 throw하지만, `createTickerSymbol`은 어떤 문자열이든 수용
  - 빈 문자열 `""`, 공백만 `"   "` 등도 유효한 `TickerSymbol`이 됨
  - 심각도: 중간 (Phase 16-18 금융 스킬 구현 시 고려)

- **R3**: `FinClawError.message`와 `Error.message`의 관계
  - `FinClawError`는 `Error`를 확장하지 않는 독립 인터페이스
  - `Result<T, FinClawError>` 패턴에서 `catch`로 잡은 Error와 변환 시 혼동 가능
  - 심각도: 낮음 (§5.5 가이드라인 "Result 반환 함수는 throw하지 않음"으로 분리됨)
