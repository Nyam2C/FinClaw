// packages/server/src/cli/exit-codes.ts

export type ExitCode = 0 | 1 | 2 | 3 | 4;

export const EXIT = {
  OK: 0,
  ERROR: 1,
  USAGE: 2,
  GATEWAY_ERROR: 3,
  CONFIG_ERROR: 4,
} as const satisfies Record<string, ExitCode>;
