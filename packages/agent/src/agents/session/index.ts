export type { LockResult, LockOptions } from './write-lock.js';
export { acquireWriteLock, resetHeldLocks } from './write-lock.js';

export type {
  TranscriptEntry,
  CorruptionType,
  DetectedCorruption,
  CorruptionReport,
} from './transcript-repair.js';
export { detectCorruption, repairTranscript } from './transcript-repair.js';

export {
  truncateToolResult,
  truncateToolResultText,
  applyToolResultGuard,
  HARD_MAX_TOOL_RESULT_CHARS,
  MIN_KEEP_CHARS,
  TRUNCATION_SUFFIX,
} from './tool-result-guard.js';
