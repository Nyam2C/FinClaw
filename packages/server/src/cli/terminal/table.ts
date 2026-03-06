// packages/server/src/cli/terminal/table.ts

/**
 * 간단한 텍스트 테이블 포매터.
 * columns를 지정하면 해당 키만 출력. 미지정 시 첫 행의 모든 키 사용.
 */
export function formatTable(
  rows: readonly Record<string, unknown>[],
  columns?: readonly string[],
): string {
  if (rows.length === 0) {
    return '';
  }

  const firstRow = rows[0];
  const keys = columns ?? Object.keys(firstRow as Record<string, unknown>);

  // 컬럼별 최대 너비 계산 (헤더 포함)
  const widths = keys.map((key) => {
    const values = rows.map((row) => String(row[key] ?? ''));
    return Math.max(key.length, ...values.map((v) => v.length));
  });

  const header = keys.map((key, i) => key.padEnd(widths[i] ?? 0)).join('  ');
  const separator = widths.map((w) => '-'.repeat(w)).join('  ');
  const body = rows
    .map((row) => keys.map((key, i) => String(row[key] ?? '').padEnd(widths[i] ?? 0)).join('  '))
    .join('\n');

  return `${header}\n${separator}\n${body}`;
}

/**
 * key: value 형식으로 객체 출력.
 */
export function formatKeyValue(obj: Record<string, unknown>): string {
  const entries = Object.entries(obj);
  if (entries.length === 0) {
    return '';
  }

  const maxKeyLen = Math.max(...entries.map(([k]) => k.length));
  return entries.map(([key, value]) => `${key.padEnd(maxKeyLen)}  ${String(value)}`).join('\n');
}
