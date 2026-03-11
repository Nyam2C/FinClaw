// packages/server/src/cli/terminal/theme.ts
import pc from 'picocolors';

export const theme = {
  success: pc.green,
  error: pc.red,
  warn: pc.yellow,
  info: pc.cyan,
  dim: pc.dim,
  bold: pc.bold,
} as const;
