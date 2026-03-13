// packages/server/src/services/hooks/types.ts

/** 훅 이벤트 타입 */
export type HookEventType =
  | 'gateway' // Gateway 라이프사이클 (startup, shutdown, reload)
  | 'agent' // 에이전트 이벤트 (bootstrap, turn-start, turn-end)
  | 'session' // 세션 이벤트 (start, end, new)
  | 'command' // CLI 명령어 이벤트
  | 'market' // 금융: 시장 데이터 이벤트 (update, alert-triggered)
  | 'channel'; // 채널 이벤트 (message-received, message-sent)

/** 훅 이벤트 */
export interface HookEvent {
  readonly type: HookEventType;
  readonly action: string;
  readonly timestamp: number;
  readonly context: Record<string, unknown>;
}

/** 훅 핸들러 함수 */
export type HookHandler = (event: HookEvent) => Promise<void> | void;

/** 훅 소스 계층 (우선순위 순서) */
export type HookSource = 'system' | 'plugin' | 'channel' | 'user';

/** 훅 엔트리 — 레지스트리에 등록되는 단위 */
export interface HookEntry {
  readonly id: string;
  readonly name: string;
  readonly source: HookSource;
  readonly events: string[]; // 구독할 이벤트 키 배열 (예: ['market', 'market:update'])
  readonly handler: HookHandler;
  readonly priority: number; // 0=최고 우선순위, 기본값은 source별 상이
  readonly enabled: boolean;
}

/** 훅 실행 모드 */
export type HookRunMode =
  | 'parallel' // Promise.allSettled 동시 실행
  | 'sequential' // 순차 실행 (에러 격리)
  | 'sync'; // 동기적 순차 실행 (async 무시)

/** 훅 러너 인터페이스 */
export interface HookRunner {
  trigger(event: HookEvent): Promise<void>;
  readonly mode: HookRunMode;
}

/** 훅 러너 옵션 */
export interface HookRunnerOptions {
  readonly mode: HookRunMode;
  readonly timeoutMs?: number; // 핸들러별 타임아웃 (기본 30초)
  readonly onError?: (error: Error, handler: HookEntry) => void;
}

/** 훅 등록 입력 (priority 선택적) */
export type HookRegistration = Omit<HookEntry, 'priority'> & { priority?: number };
