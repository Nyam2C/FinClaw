export type { LockResult, LockOptions } from './write-lock.js';
export { acquireWriteLock, resetHeldLocks } from './write-lock.js';

export type {
  TranscriptEntry,
  CorruptionType,
  DetectedCorruption,
  CorruptionReport,
} from './transcript-repair.js';
export { detectCorruption, repairTranscript } from './transcript-repair.js';
