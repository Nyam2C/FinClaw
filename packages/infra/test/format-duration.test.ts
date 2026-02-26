import { describe, it, expect } from 'vitest';
import { formatDuration } from '../src/format-duration.js';

describe('formatDuration', () => {
  it('0ms를 반환한다', () => {
    expect(formatDuration(0)).toBe('0ms');
  });

  it('밀리초 단위를 반환한다', () => {
    expect(formatDuration(500)).toBe('500ms');
    expect(formatDuration(999)).toBe('999ms');
  });

  it('초 단위를 반환한다', () => {
    expect(formatDuration(1000)).toBe('1s');
    expect(formatDuration(5000)).toBe('5s');
  });

  it('분 + 초를 반환한다', () => {
    expect(formatDuration(90000)).toBe('1m 30s');
  });

  it('시 + 분 + 초를 반환한다', () => {
    expect(formatDuration(3661000)).toBe('1h 1m 1s');
  });

  it('정확히 1시간을 반환한다', () => {
    expect(formatDuration(3600000)).toBe('1h');
  });

  it('음수에 0ms를 반환한다', () => {
    expect(formatDuration(-100)).toBe('0ms');
  });
});
