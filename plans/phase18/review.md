# Phase 18: 알림 시스템 — 구현 리뷰

## 리뷰 일자: 2026-03-16

## todo.md 대비 구현 일치도

구현은 todo.md의 20개 파일 사양과 **거의 완벽히 일치**한다. 모든 파일이 생성/수정되었고, 코드 구조·패턴·로직이 todo.md의 코드 블록과 1:1 매칭된다.

---

## 발견 이슈

### R9. `tools.ts` — `cooldownMs` 할당 `?? undefined` 중복

- **파일**: `packages/skills-finance/src/alerts/tools.ts` L58
- **코드**: `cooldownMs: (input.cooldownMs as number | undefined) ?? undefined,`
- **문제**: `undefined ?? undefined`는 `undefined`이므로 nullish coalescing이 무의미. `input.cooldownMs as number | undefined`로 충분.
- **심각도**: 낮음 (동작에 영향 없음, 코드 스멜)
- **수정**: `cooldownMs: input.cooldownMs as number | undefined,`

---

### R10. Discord 커맨드 (`alert.ts`) — v2/v3 스키마 불일치

- **파일**: `packages/channel-discord/src/commands/alert.ts` L54-65
- **코드**:
  ```typescript
  const alert = await deps.alertStorage.createAlert({
    name: `${ticker} ${condition} ${value}`,
    symbol: ticker as import('@finclaw/types').TickerSymbol,
    condition: {
      type: condition as import('@finclaw/types').AlertConditionType,
      value,
    },
    // ...
  });
  ```
- **문제**: Discord 커맨드는 v2 `alertStorage.createAlert()` (`@finclaw/types`의 `Alert` — `symbol`, `condition: {type, value}`)를 사용. Phase 18의 v3 `AlertStore.create()` (`CreateAlertInput` — `condition: AlertCondition` discriminated union, `userId`, `channels`)와 **완전 별개 레이어**.
- todo.md L1184에도 "별도 레이어" 명시 — 의도적 설계이나, 향후 v2 alertStorage 제거 시 정리 필요.
- **심각도**: 중간 (현재 동작하지만, 두 alert 시스템이 공존하여 혼란 가능)
- **수정**: 향후 phase에서 Discord 커맨드를 v3 AlertStore로 마이그레이션

---

### R11. `store.test.ts` — 미사용 변수 `updatedAlert`

- **파일**: `packages/skills-finance/src/alerts/__tests__/store.test.ts` L158
- **코드**: `const updatedAlert = store.getById(alert.id)!;`
- **문제**: 선언 후 사용하지 않음. 바로 아래서 DB 직접 조회로 `trigger_count`를 검증하기 때문. `trigger_count`가 `AlertDefinition` 인터페이스에 없어서 DB 직접 조회가 필요한 것은 맞지만, `updatedAlert` 변수 자체가 불필요.
- **심각도**: 낮음 (lint 경고 가능)
- **수정**: `const updatedAlert = ...` 행 삭제

---

### R12. `AlertDefinition`에 `trigger_count` 미포함

- **파일**: `packages/skills-finance/src/alerts/types.ts` L38-49
- **문제**: DB에 `trigger_count INTEGER NOT NULL DEFAULT 0` 컬럼이 있고 `recordTrigger`에서 증가시키지만, `AlertDefinition` 인터페이스에 노출되지 않음. 클라이언트가 trigger_count를 확인할 방법이 없음 (list_alerts 응답에 미포함).
- **심각도**: 중간 (기능 갭)
- **수정 제안**: `AlertDefinition`에 `readonly triggerCount: number` 추가, `rowToAlertDefinition()`에서 매핑

---

### R13. `market-service.ts` — `symbol as string` 타입 캐스트

- **파일**: `packages/skills-finance/src/alerts/market-service.ts` L16
- **코드**: `const quote = await deps.cache.getQuote(symbol as string, ...)`
- **문제**: `createTickerSymbol`이 branded type을 반환하므로 `MarketCache.getQuote` 시그니처에 따라 `as string` 캐스트 필요. 이전 phase의 패턴과 일관적이나, branded type의 타입 안전성을 우회.
- **심각도**: 낮음 (기존 패턴 답습, 일관성 유지)
- **수정**: 없음 (현재로서는 의도적 설계)

---

### R14. `delivery.ts` `formatAlertMessage` — 시각 불일치 가능성

- **파일**: `packages/skills-finance/src/alerts/delivery.ts` L20
- **코드**: `` `시각: ${new Date().toLocaleString('ko-KR')}` ``
- **문제**: alert 트리거 시각이 아닌 메시지 포맷 시각을 사용. 전달 핸들러 간 시간 차이 가능 (Discord DM vs WebSocket에서 각각 `formatAlertMessage`를 호출하면 밀리초 단위 차이).
- **심각도**: 낮음 (실용적 영향 미미)
- **수정 제안**: `evaluation` 또는 별도 `triggeredAt` 파라미터로 시각 통일

---

### R15. `set_alert` 도구 — `channels` 하드코딩

- **파일**: `packages/skills-finance/src/alerts/tools.ts` L57
- **코드**: `channels: ['discord', 'websocket'],`
- **문제**: 사용자가 채널 선택 불가. `inputSchema`에 channels 파라미터 없음.
- **심각도**: 낮음 (MVP 단계에서 합리적)
- **수정 제안**: 향후 `inputSchema`에 optional `channels` 파라미터 추가

---

## 이슈 요약

| #   | 파일               | 심각도 | 유형        | 즉시 수정 필요      |
| --- | ------------------ | ------ | ----------- | ------------------- |
| R9  | tools.ts           | 낮음   | 코드 스멜   | 선택                |
| R10 | alert.ts (Discord) | 중간   | 설계 부채   | 아니오 (향후 phase) |
| R11 | store.test.ts      | 낮음   | 미사용 변수 | 선택                |
| R12 | types.ts           | 중간   | 기능 갭     | 권장                |
| R13 | market-service.ts  | 낮음   | 타입 캐스트 | 아니오              |
| R14 | delivery.ts        | 낮음   | 시각 불일치 | 선택                |
| R15 | tools.ts           | 낮음   | 하드코딩    | 아니오 (MVP)        |

## 결론

Phase 18 구현은 plan.md / todo.md 사양에 충실하며, 발견된 이슈는 모두 동작에 영향을 주지 않는 낮은~중간 심각도이다. **R12 (triggerCount 미노출)**가 가장 실질적인 기능 갭이며, **R10 (v2/v3 공존)**은 향후 정리가 필요한 설계 부채다. 나머지는 코드 품질 개선 수준이다.
