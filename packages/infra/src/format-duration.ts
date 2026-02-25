// packages/infra/src/format-duration.ts

/**
 * 밀리초를 "2h 30m 15s" 형식으로 변환
 *
 * - 0ms → "0ms"
 * - 999ms → "999ms"
 * - 1000ms → "1s"
 * - 3661000ms → "1h 1m 1s"
 */
export function formatDuration(ms: number): string {
  if (ms < 0) {
    return '0ms';
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }

  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  const parts: string[] = [];
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes % 60 > 0) {
    parts.push(`${minutes % 60}m`);
  }
  if (seconds % 60 > 0) {
    parts.push(`${seconds % 60}s`);
  }

  return parts.join(' ') || '0s';
}
