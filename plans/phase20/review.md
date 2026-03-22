# Phase 20 구현 리뷰

## Todo별 구현 일치도

| Todo | 항목                                     | 상태 | 비고                                                                          |
| ---- | ---------------------------------------- | ---- | ----------------------------------------------------------------------------- |
| 1    | 플러그인 템플릿 (3파일)                  | OK   | finclaw-plugin.json, package.json, src/index.ts 모두 todo 명세 일치           |
| 2    | 빌드 스크립트 (3파일)                    | OK   | write-build-info.ts, calver.ts, check-dep-versions.ts todo 명세 일치          |
| 3    | 버전 하드코딩 해소 (4파일)               | OK   | version.ts 신규 + health.ts/router.ts/system.ts 3곳 `loadVersion()` 교체 완료 |
| 4    | Dockerfile HEALTHCHECK                   | OK   | 주석 해제, `/healthz` 엔드포인트 사용                                         |
| 5    | release.yml + dependabot.yml             | OK   | todo 명세 일치                                                                |
| 6    | build-skills.ts + zod 업그레이드         | OK   | `^3.25.0` → `^4.0.0`, build-skills.ts 구현 완료                               |
| 추가 | .gitignore에 `build-info.json` 추가      | OK   | todo에 미명시지만 적절한 추가                                                 |
| 추가 | health.test.ts `'0.1.0'` → `'0.0.0-dev'` | OK   | 버전 변경에 따른 테스트 수정                                                  |

## 상세 리뷰

### Todo 1 — 플러그인 템플릿

- `PluginApi` 축약 타입: `registerHook` + `registerCommand`만 정의 — todo 주의사항의 "사용하는 메서드만 축약" 원칙 준수
- `handler` 시그니처 `(args: string[]) => Promise<string>`: todo에서 지적한 실제 `PluginCommand.handler` 시그니처와 일치 (plan.md의 `execute`가 아닌 실제 코드 기준)
- `workspace:*` 미사용: todo 주의사항 준수 (extensions/는 워크스페이스 외부)

### Todo 2 — 빌드 스크립트

- 3개 스크립트 모두 외부 의존성 없이 Node.js 내장 API만 사용
- `write-build-info.ts`: `git describe --tags --always` + `git rev-parse --short HEAD` 패턴, fallback `'0.0.0-dev'`
- `calver.ts`: YYYY.M.D + 동일 날짜 suffix 로직, `--tag` 옵션
- `check-dep-versions.ts`: `workspace:*` 제외, 불일치 시 exit 1

### Todo 3 — 버전 하드코딩 해소

- `version.ts`: 모듈 스코프 캐시 + `import.meta.dirname` 기반 경로 계산 + `resetVersionCache()` 테스트 유틸
- 3곳 (`health.ts:52`, `router.ts:140`, `system.ts:48`) 모두 `loadVersion()` 교체 완료
- `health.test.ts` L33: `'0.1.0'` → `'0.0.0-dev'` (build-info.json 없는 테스트 환경 반영)

### Todo 4 — Dockerfile

- TODO 주석 3줄 제거, HEALTHCHECK 2줄로 교체
- `/healthz` (liveness) 사용 — todo의 "Docker HEALTHCHECK에 `/readyz` 부적합" 분석 반영

### Todo 5 — CI/CD

- `release.yml`: `v*` 태그 트리거, 빌드 검증 파이프라인 포함, `softprops/action-gh-release@v2`, pre-release 자동 감지
- `dependabot.yml`: github-actions + npm weekly, dev-dependencies 그룹핑

### Todo 6 — 스킬 빌드 + zod

- `build-skills.ts`: `SKILL_DIRS` 하드코딩 (`market`, `news`, `alerts`), `cpSync` 사용, `skill.meta.json` 생성
- zod `^3.25.0` → `^4.0.0` 변경, pnpm-lock.yaml 갱신 포함

## 발견 사항

### 리팩토링 후보

1. **`build-skills.ts` 스킬 목록 하드코딩** (`scripts/build-skills.ts:21`)
   - `SKILL_DIRS = ['market', 'news', 'alerts'] as const`로 하드코딩
   - 새 스킬 추가 시 이 배열도 수동 업데이트 필요
   - 대안: `packages/skills-finance/dist/` 디렉토리를 `readdirSync`로 자동 탐색
   - 단, 현재 스킬이 3개로 고정되어 있고 plan.md에서도 명시적이므로 즉시 변경 필요성은 낮음

2. **`release.yml`에서 `build-skills.ts` 미호출**
   - 릴리즈 파이프라인이 `pnpm build` + `pnpm test:ci`만 실행
   - 스킬 번들링(`tsx scripts/build-skills.ts`)이 릴리즈 프로세스에 포함되지 않음
   - 스킬을 독립 배포 단위로 사용할 계획이라면 릴리즈 시 번들링 + artifact 업로드 단계 추가 필요
   - 현 단계에서는 수동 실행으로 충분할 수 있음

3. **`calver.ts` git tag 명령의 shell injection 가능성** (`scripts/calver.ts:36`)
   - `execSync(\`git tag -a ${tagName} ...\`)`—`tagName`은 `generateCalVer()`에서 숫자/점만 생성하므로 현재는 안전
   - 하지만 방어적으로 `execSync`에 배열 기반 `execFileSync`를 사용하면 더 안전

4. **`write-build-info.ts`/`calver.ts` 공통 `exec()` 헬퍼 중복**
   - 두 스크립트 모두 동일한 `exec(cmd: string): string` 패턴 사용
   - 공유 유틸로 추출 가능하나, 독립 스크립트 원칙상 현재 상태가 적절

5. **플러그인 템플릿 `PluginApi` 동기화 리스크** (`extensions/plugin-template/src/index.ts:11-23`)
   - `loader.ts`의 `PluginBuildApi` 변경 시 템플릿이 자동으로 반영되지 않음
   - `@see` 주석으로 원본 위치를 명시한 것은 좋으나, structural typing에 의존하므로 런타임에는 문제 없음
   - 향후 `@finclaw/server`에 `exports` 필드 추가 시 직접 import로 전환 권장
