# Phase 5 todo-b 리뷰: 매니페스트 + 보안 + 5-Stage 파이프라인

## 파일 대조 요약 (소스 3 + 테스트 4 = 7파일)

| 파일                               | 스펙 일치 | 비고                              |
| ---------------------------------- | --------- | --------------------------------- |
| `src/plugins/manifest.ts`          | 100%      | —                                 |
| `src/plugins/discovery.ts`         | 100%      | 보안 취약점 1건 (아래)            |
| `src/plugins/loader.ts`            | 100%      | 미사용 import, JSDoc 순서 불일치  |
| `test/plugins/manifest.test.ts`    | 100%      | —                                 |
| `test/plugins/discovery.test.ts`   | 100%      | —                                 |
| `test/plugins/loader.test.ts`      | ~98%      | 서비스 이름 변경 (스펙 버그 수정) |
| `test/plugins/diagnostics.test.ts` | 100%      | —                                 |

## 주요 발견 사항

### 1. [보안] Path traversal 접두사 매칭 취약점 — `discovery.ts:55`

```typescript
const isAllowed = allowedRoots.some((root) => realPath.startsWith(path.resolve(root)));
```

`startsWith`에 경로 구분자가 없어서 우회 가능:

- allowedRoot: `/tmp/plugins`
- 공격 경로: `/tmp/plugins-evil/malicious.ts`
- `'/tmp/plugins-evil/malicious.ts'.startsWith('/tmp/plugins')` → **true** (우회 성공)

**수정:** `path.resolve(root) + path.sep`로 변경하거나, `realPath === resolvedRoot || realPath.startsWith(resolvedRoot + path.sep)` 패턴 사용.

### 2. [버그] 미사용 import `PluginLoadError` — `loader.ts:17`

```typescript
import { PluginLoadError } from './errors.js';
```

catch 블록에서 `PluginLoadError`를 throw하지 않고 `recordDiagnostic`을 직접 사용한다. lint 에러 대상.

### 3. [문서] JSDoc과 실제 파이프라인 순서 불일치 — `loader.ts:147-154`

JSDoc:

```
Stage 2: Security → Stage 3: Manifest
```

실제 코드 (`loader.ts:169-183`):

```
Stage 2: Manifest Parse → Stage 3: Security
```

코드 순서가 정확하다 — 매니페스트를 먼저 파싱해야 `main` entry 경로를 알 수 있으므로 security 검증은 그 뒤에 와야 한다. JSDoc을 코드 순서에 맞게 수정해야 한다.

### 4. [테스트] 서비스 이름 변경 — `loader.test.ts:99-108` (스펙 버그 수정)

스펙의 `both-plugin` 테스트에서 서비스 이름이 `reg-svc` / `act-svc`였는데, 이전 테스트(`activate-plugin`)가 `act-svc`를 등록하기 때문에 `expect(some(s => s.name === 'act-svc')).toBe(false)` 단언이 실패한다.

실제 구현은 `both-reg-svc` / `both-act-svc`로 변경하여 이름 충돌을 회피했다. **올바른 수정.**

### 5. [설계] 미사용 내보내기

- `PluginExports` 인터페이스 (`loader.ts:23-28`): 정의만 있고 타입 검증에 사용되지 않음. `mod`는 `Record<string, unknown>`으로 타입됨.
- `resetJiti()` (`loader.ts:65`): 테스트용으로 export 되었으나 어떤 테스트도 사용하지 않음.
- `loadPluginModule` (`loader.ts:255`): 내부 함수인데 export됨. 테스트에서도 사용하지 않음.

### 6. [주의] WSL world-writable 검사 — `discovery.ts:67`

`process.platform !== 'win32'`로 분기하는데, WSL에서 `process.platform`은 `'linux'`을 반환한다. Windows 파일시스템(`/mnt/c/`) 위의 파일은 기본 퍼미션이 0o777이어서 false positive 발생 가능. 현재 테스트는 `/tmp/` (네이티브 리눅스)에서 실행되므로 문제없으나, 실제 운영 시 주의 필요.

### 7. [테스트] tmpDir 생성 위치 — `loader.test.ts:16`

```typescript
tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finclaw-loader-'));
```

모듈 레벨에서 생성. `discovery.test.ts`는 `beforeAll` 내에서 생성. 동작에는 문제 없으나 패턴 불일치.

또한 각 테스트가 tmpDir에 플러그인 디렉터리를 누적 생성하므로, 이후 `loadPlugins([tmpDir])` 호출 시 이전 테스트의 플러그인도 함께 발견된다. 현재 단언(`toContain`, `find`)이 이를 허용하는 형태라 통과하지만, `toHaveLength` 같은 엄격한 단언 추가 시 깨질 수 있다.

## 리팩토링 목록

| #   | 우선순위 | 파일                     | 내용                                                                  |
| --- | -------- | ------------------------ | --------------------------------------------------------------------- |
| R1  | **높음** | `discovery.ts:55`        | `startsWith` → `startsWith(root + path.sep)` path traversal 수정      |
| R2  | 중간     | `loader.ts:17`           | `PluginLoadError` 미사용 import 제거                                  |
| R3  | 중간     | `loader.ts:147-154`      | JSDoc 파이프라인 순서를 실제 코드에 맞게 수정 (Manifest → Security)   |
| R4  | 낮음     | `loader.ts:23-28,65,255` | 미사용 export 정리 (`PluginExports`, `resetJiti`, `loadPluginModule`) |
| R5  | 낮음     | `loader.test.ts:16`      | tmpDir 생성을 `beforeAll`로 이동 (discovery.test.ts 패턴 통일)        |
