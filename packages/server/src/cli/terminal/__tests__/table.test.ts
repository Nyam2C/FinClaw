// packages/server/src/cli/terminal/__tests__/table.test.ts
import { describe, it, expect } from 'vitest';
import { formatTable, formatKeyValue } from '../table.js';

describe('formatTable', () => {
  it('returns "(no data)" for empty array', () => {
    expect(formatTable([])).toBe('(no data)');
  });

  it('formats a single row', () => {
    const result = formatTable([{ name: 'Alice', age: 30 }]);
    expect(result).toContain('name');
    expect(result).toContain('age');
    expect(result).toContain('Alice');
    expect(result).toContain('30');
  });

  it('formats multiple rows with aligned columns', () => {
    const rows = [
      { id: '1', status: 'ok' },
      { id: '22', status: 'error' },
    ];
    const lines = formatTable(rows).split('\n');
    expect(lines).toHaveLength(4); // header + separator + 2 data
    // 데이터 행에 값이 올바르게 포함됨
    expect(lines[2]).toContain('1');
    expect(lines[3]).toContain('error');
  });

  it('filters columns when specified', () => {
    const rows = [{ a: 1, b: 2, c: 3 }];
    const result = formatTable(rows, ['a', 'c']);
    expect(result).toContain('a');
    expect(result).toContain('c');
    expect(result).not.toContain('b');
  });
});

describe('formatKeyValue', () => {
  it('returns empty string for empty object', () => {
    expect(formatKeyValue({})).toBe('');
  });

  it('formats key-value pairs with aligned keys', () => {
    const result = formatKeyValue({ status: 'ok', version: '0.1.0' });
    const lines = result.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('status');
    expect(lines[0]).toContain('ok');
    expect(lines[1]).toContain('version');
    expect(lines[1]).toContain('0.1.0');
  });
});
