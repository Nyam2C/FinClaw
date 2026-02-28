# Phase 7 TODO-1 코드 리뷰

> 도구 시스템 코어 (기반 타입 & 레지스트리 + 정책 & 실행 파이프라인)
>
> 수정 3개 + 소스 5개 + 테스트 4개 = 12 작업

---

## 1. 명세 일치 체크리스트

| Step | 설명                                                         | 파일                                                    | 일치             |
| ---- | ------------------------------------------------------------ | ------------------------------------------------------- | ---------------- |
| 0    | agent 패키지에 zod 의존성 추가                               | `packages/agent/package.json`                           | ✅ `zod: ^4.0.0` |
| 1    | FinClawEventMap에 tool:\* 이벤트 9종                         | `packages/infra/src/events.ts:70-79`                    | ✅               |
| 2    | PluginHookName에 도구 훅 2종                                 | `packages/types/src/plugin.ts:76-77`                    | ✅               |
| 3    | HookPayloadMap에 beforeToolExecute/afterToolExecute          | `packages/server/src/plugins/hook-types.ts:15-28,42-43` | ✅               |
| 4    | groups.ts — ToolGroupId, ToolGroup, BUILT_IN_GROUPS          | `packages/agent/src/agents/tools/groups.ts`             | ✅               |
| 5    | registry.ts 타입 — RegisteredToolDefinition 외 8종           | `packages/agent/src/agents/tools/registry.ts:17-123`    | ✅               |
| 6    | InMemoryToolRegistry CRUD 6메서드                            | `packages/agent/src/agents/tools/registry.ts:161-226`   | ✅               |
| 7    | policy.ts — PolicyRule, matchToolPattern                     | `packages/agent/src/agents/tools/policy.ts:1-61`        | ✅               |
| 8    | 9단계 evaluateToolPolicy                                     | `packages/agent/src/agents/tools/policy.ts:63-261`      | ✅ \*            |
| 9    | result-guard.ts — guardToolResult, FINANCIAL_REDACT_PATTERNS | `packages/agent/src/agents/tools/result-guard.ts`       | ✅ \*            |
| 10   | execute() 파이프라인 (Zod→정책→루프→훅→타임아웃→CB→가드)     | `packages/agent/src/agents/tools/registry.ts:228-369`   | ✅               |
| 11   | index.ts 배럴 export                                         | `packages/agent/src/agents/tools/index.ts`              | ✅               |

**결론: 모든 Step(0~11) 구현 완료, 코드 내용이 todo-1.md 명세와 일치.**

### 명세 대비 세부 차이 2건 (의도적 개선, 기능 동일)

1. **`policy.ts:73`** — 명세 `.sort()` → 구현 `.toSorted()`
   - 원본 배열을 변경하지 않는 불변 정렬. 기능 동일, 불변성 향상.
   - Node 22+에서 지원하므로 런타임 문제 없음.

2. **`tool-groups.test.ts:35-36, 41-42`** — 명세 `find(...)!.prop` → 구현 `find(...)?.prop`
   - 비널 단언(`!`) 대신 옵셔널 체이닝(`?.`) 사용.
   - 테스트에서 `find` 결과가 없으면 `undefined`가 되어 `toBe` 단언이 실패하므로 동일한 검증 효과.

---

## 2. 발견된 이슈 (3건)

### 이슈 1: result-guard.ts — RegExp 3중 생성 (낮음)

**위치:** `result-guard.ts:93-98`, `103-108`

각 redact 패턴에 대해 RegExp가 3개 생성됨:

1. `new RegExp(pattern.source, pattern.flags)` — test용
2. `new RegExp(pattern.source, pattern.flags)` — replace용
3. 원본 pattern 객체 (미사용)

```typescript
// 현재 코드
const re = new RegExp(pattern.source, pattern.flags);
if (re.test(content)) {
  // ← 1번째 RegExp
  wasRedacted = true;
  content = content.replace(
    new RegExp(pattern.source, pattern.flags), // ← 2번째 RegExp
    '[REDACTED]',
  );
}
```

**문제:** `re.test()`가 global 플래그 RegExp의 `lastIndex`를 변경하므로 동일 인스턴스를 재사용할 수 없어 새로 생성하는 것은 의도된 패턴이지만, test 자체가 불필요함. replace가 매칭이 없으면 원본을 그대로 반환하므로 test를 건너뛰고 replace 결과를 비교하면 됨.

**심각도:** 낮음 (성능 미미, 정확성 문제 없음)

---

### 이슈 2: registry.ts — execute() 에러 경로에서 `tool:execute:end` 이벤트 미발행 (중간)

**위치:** `registry.ts:361-368`

```typescript
} catch (error) {
  const errMsg = error instanceof Error ? error.message : String(error);
  bus.emit('tool:execute:error', name, context.sessionId, errMsg);
  // ← tool:execute:end 미발행
  return guardToolResult(
    { content: `Tool execution failed: ${errMsg}`, isError: true },
    this.guardOptions,
  );
}
```

`tool:execute:start` (line 242)와 `tool:execute:end` (line 355)는 정상 경로에서만 쌍을 이룸. 에러 경로(catch)에서는 `tool:execute:error`만 발행되고 `tool:execute:end`는 빠져있음.

**영향:** 이벤트 기반 모니터링(duration 추적, 동시 실행 카운트 등)에서 start/end 비대칭이 발생하여 실행 중인 도구 수가 영원히 감소하지 않는 누수 가능.

추가: Zod 검증 실패 (line 257)와 정책 deny (line 280)에서도 `start`는 발행되었으나 `end`는 미발행. 이들은 "실행 전 검증 단계"로 볼 수 있으나, `start` 이후의 모든 경로에서 `end`를 보장하는 것이 일관적.

**심각도:** 중간 (모니터링 정합성)

---

### 이슈 3: evaluateToolPolicy — decidingStage 'fallthrough' 라벨 (낮음)

**위치:** `policy.ts:255-260`

```typescript
return {
  finalVerdict: 'allow',
  stageResults,
  decidingStage: 'fallthrough', // ← Stage 9가 'allow'를 반환했으나 무시됨
  reason: 'No matching policy rule found, defaulting to allow',
};
```

Stage 9 (`evaluateDefault`)는 항상 `{ verdict: 'allow', stage: 'default-policy' }`를 반환하지만, 메인 루프의 switch에서 `allow`는 `continue`와 동일하게 `default: break;`로 처리됨. 루프 종료 후 `decidingStage: 'fallthrough'`가 설정됨.

**영향:** 기능적으로 정확(최종 verdict는 'allow'). 다만 `decidingStage`가 'default-policy'가 아닌 'fallthrough'로 표시되어 로그/디버깅 시 혼란 가능. `tool:policy:verdict` 이벤트에 'fallthrough' 스테이지가 전달됨.

**심각도:** 낮음 (기능 정확, 라벨만 부정확)

---

## 3. 리팩토링 제안 (2건)

### 제안 1: result-guard.ts redact 로직 단순화

test를 제거하고 replace만 사용. replace 전후 비교로 wasRedacted 판정:

```typescript
// before (현재)
const re = new RegExp(pattern.source, pattern.flags);
if (re.test(content)) {
  wasRedacted = true;
  content = content.replace(new RegExp(pattern.source, pattern.flags), '[REDACTED]');
}

// after (제안)
const re = new RegExp(pattern.source, pattern.flags);
const replaced = content.replace(re, '[REDACTED]');
if (replaced !== content) {
  wasRedacted = true;
  content = replaced;
}
```

RegExp 생성 3→1, 불필요한 test 제거.

---

### 제안 2: execute() 에러 경로에 tool:execute:end 이벤트 추가

```typescript
} catch (error) {
  const errMsg = error instanceof Error ? error.message : String(error);
  bus.emit('tool:execute:error', name, context.sessionId, errMsg);
  bus.emit('tool:execute:end', name, context.sessionId, Date.now() - startTime);  // 추가
  return guardToolResult(
    { content: `Tool execution failed: ${errMsg}`, isError: true },
    this.guardOptions,
  );
}
```

또는 try/finally 패턴으로 모든 경로에서 end를 보장:

```typescript
const startTime = Date.now();
bus.emit('tool:execute:start', name, context.sessionId);
try {
  // ... 기존 로직 ...
} finally {
  bus.emit('tool:execute:end', name, context.sessionId, Date.now() - startTime);
}
```

---

## 4. 테스트 커버리지 요약

| 테스트 파일             | 테스트 수 | 커버 대상                                                           |
| ----------------------- | --------- | ------------------------------------------------------------------- |
| `tool-groups.test.ts`   | 5         | BUILT_IN_GROUPS 구조, 필드, 그룹별 기본값                           |
| `tool-registry.test.ts` | 8         | CRUD, toApiToolDefinition, execute 정상/에러/정책/훅                |
| `tool-policy.test.ts`   | 8         | matchToolPattern, 9단계 파이프라인 (deny/allow/scope/transactional) |
| `result-guard.test.ts`  | 10        | null/정상/truncation/금융마스킹/커스텀패턴/HTML/제어문자            |

총 31개 테스트. 주요 분기 커버됨.

---

## 5. 종합 판정

**구현 상태: 완료 ✅**

- 명세 12개 Step 전부 구현, 코드 품질 양호
- 발견 이슈 3건 중 실제 버그는 없으나, 이슈 2(start/end 비대칭)는 향후 모니터링 로직 작성 전에 수정 권장
- 리팩토링 2건은 선택적이며 TODO-2 진행에 차단 요소 아님
