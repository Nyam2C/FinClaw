// packages/server/src/services/index.ts

// ── Hooks ──
export type {
  HookEventType,
  HookEvent,
  HookHandler,
  HookSource,
  HookEntry,
  HookRunMode,
  HookRunner,
  HookRunnerOptions,
  HookRegistration,
} from './hooks/types.js';
export { HookRegistry } from './hooks/registry.js';
export { createServiceHookRunner } from './hooks/runner.js';
export { bridgeEventBusToHooks } from './hooks/bridge.js';

// ── Security ──
export type { RedactionPattern } from './security/redaction.js';
export { REDACTION_PATTERNS, redactSensitiveText, redactObject } from './security/redaction.js';
export type {
  SecurityAuditFinding,
  SecurityAuditReport,
  SecurityAuditOptions,
} from './security/audit.js';
export { runSecurityAudit } from './security/audit.js';

// ── Daemon ──
export type { SystemdServiceOptions } from './daemon/systemd.js';
export { isSystemdAvailable, generateSystemdService } from './daemon/systemd.js';
