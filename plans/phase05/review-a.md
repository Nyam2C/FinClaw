# Phase 5 todo-a 구현 리뷰

> 대상 브랜치: `eature/channel-plugin` vs `main`
> 명세: `plans/phase05/todo-a.md` (세션 1-2: 기반 레이어 — 타입 확장 + 레지스트리 + 훅)

---

## 파일별 대조 결과

| #   | 파일                                               | 명세 항목                                                                                            | 판정            | 비고                                       |
| --- | -------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------ |
| 1-1 | `packages/types/src/plugin.ts`                     | PluginManifest +3필드, RouteRegistration, PluginDiagnostic, PluginRegistry 8슬롯, PluginHookName 9종 | **일치**        | additive 수정, 기존 필드 변경 없음         |
| 1-2 | `packages/server/package.json`                     | jiti@^2.6.0, zod@^4.0.0 추가                                                                         | **일치**        | pnpm-lock.yaml 갱신 확인됨                 |
| 1-3 | `packages/server/src/plugins/errors.ts`            | PluginLoadError, PluginSecurityError, RegistryFrozenError                                            | **일치**        | FinClawError 상속, `this.name` 재할당 포함 |
| 1-4 | `packages/server/src/plugins/hook-types.ts`        | HookPayloadMap 9종, HookModeMap 9종                                                                  | **일치**        | InboundMessage import 포함                 |
| 2-1 | `packages/server/src/plugins/registry.ts`          | globalThis Symbol 싱글턴, 8슬롯, freeze/get/set/register                                             | **일치**        | createEmptyRegistry export 포함            |
| 2-2 | `packages/server/test/plugins/registry.test.ts`    | 4 describe, 10 it                                                                                    | **일치**        | beforeEach 격리 패턴 적용                  |
| 2-3 | `packages/server/src/plugins/hooks.ts`             | 3모드 HookRunner, priority+FIFO 정렬, overload signatures                                            | **스타일 차이** | 아래 상세                                  |
| 2-4 | `packages/server/test/plugins/hooks.test.ts`       | void 3건, modifying 3건, sync 3건                                                                    | **일치**        |                                            |
| 2-5 | `packages/server/test/plugins/hooks-typed.test.ts` | priority 4건, HookPayloadMap 타입 호환 3건                                                           | **일치**        | satisfies 키워드 사용                      |

---

## 스타일 차이 상세 (hooks.ts:64)

**명세:**

```typescript
Promise.allSettled(sorted.map((e) => Promise.resolve(e.handler(payload))));
```

**구현:**

```typescript
Promise.allSettled(sorted.map(async (e) => e.handler(payload)));
```

`async` 함수는 반환값을 자동으로 `Promise.resolve()`로 감싸므로 **의미적으로 동치**. 동작 차이 없음.

---

## 파일 수 검증

| 구분        | 명세                                    | 실제  | 판정     |
| ----------- | --------------------------------------- | ----- | -------- |
| 소스 파일   | 4 (errors, hook-types, hooks, registry) | 4     | 일치     |
| 테스트 파일 | 3 (registry, hooks, hooks-typed)        | 3     | 일치     |
| 타입 수정   | 1 (plugin.ts)                           | 1     | 일치     |
| 설정 수정   | 1 (package.json)                        | 1     | 일치     |
| **합계**    | **9**                                   | **9** | **일치** |

---

## 리팩토링 후보

1. **hooks.ts — `async` wrapper vs `Promise.resolve()` 통일**
   - 현재: `sorted.map(async (e) => e.handler(payload))` (L64)
   - 명세 원안: `sorted.map((e) => Promise.resolve(e.handler(payload)))`
   - `async` wrapper는 추가 마이크로태스크를 생성하나 실무 영향 없음. 명세와 통일하려면 `Promise.resolve()` 형태로 변경 가능. **우선순위: 낮음**.

2. **registry.ts — `getSlot()` 호출 시 매번 shallow copy + Object.freeze**
   - 불변성 보장 의도이나, hot path에서 빈번 호출 시 GC 압박 가능.
   - 현 단계에서는 정합성 우선이므로 유지. Phase 6+ 게이트웨이 통합 시 프로파일링 후 판단. **우선순위: 낮음 (미래)**.

3. **errors.ts — `this.name` 재할당 중복**
   - `FinClawError` 부모 생성자에서 `this.name = 'FinClawError'`를 설정하고, 자식에서 `this.name = 'PluginLoadError'` 등으로 덮어씀.
   - 부모 클래스에서 `this.name = new.target.name`으로 자동 설정하면 자식의 수동 재할당이 불필요해짐. 단, infra 패키지 수정이 필요하므로 Phase 5 스코프 밖. **우선순위: 낮음 (infra 리팩토링 시 일괄 적용)**.
