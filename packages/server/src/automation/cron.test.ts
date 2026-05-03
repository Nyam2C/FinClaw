import { describe, expect, it } from 'vitest';
import { CronParseError, matches, nextRunAt, parseCron } from './cron.js';

describe('parseCron', () => {
  it('expands * to full range', () => {
    expect(parseCron('* * * * *').minute.length).toBe(60);
    expect(parseCron('* * * * *').hour.length).toBe(24);
    expect(parseCron('* * * * *').dayOfMonth).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
    expect(parseCron('* * * * *').dayOfWeek).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('handles step', () => {
    expect(parseCron('*/5 * * * *').minute).toEqual([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]);
    expect(parseCron('*/15 * * * *').minute).toEqual([0, 15, 30, 45]);
  });

  it('handles range', () => {
    expect(parseCron('0 9-17 * * *').hour).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  it('handles list', () => {
    expect(parseCron('0,15,30,45 * * * *').minute).toEqual([0, 15, 30, 45]);
  });

  it('rejects out-of-range', () => {
    expect(() => parseCron('60 * * * *')).toThrow(CronParseError);
    expect(() => parseCron('* 24 * * *')).toThrow(CronParseError);
  });

  it('rejects bad shape', () => {
    expect(() => parseCron('* * * *')).toThrow(/expected 5 fields/);
    expect(() => parseCron('xyz * * * *')).toThrow(CronParseError);
  });
});

describe('matches', () => {
  it('every minute matches', () => {
    const cron = parseCron('* * * * *');
    expect(matches(cron, new Date('2026-05-03T10:00:00').getTime())).toBe(true);
    expect(matches(cron, new Date('2026-05-03T10:00:30').getTime())).toBe(true);
  });

  it('hourly on minute 0', () => {
    const cron = parseCron('0 * * * *');
    expect(matches(cron, new Date('2026-05-03T10:00:00').getTime())).toBe(true);
    expect(matches(cron, new Date('2026-05-03T10:01:00').getTime())).toBe(false);
  });

  it('daily 12:00', () => {
    const cron = parseCron('0 12 * * *');
    expect(matches(cron, new Date('2026-05-03T12:00:00').getTime())).toBe(true);
    expect(matches(cron, new Date('2026-05-03T13:00:00').getTime())).toBe(false);
  });

  it('weekly mon 9:00', () => {
    const cron = parseCron('0 9 * * 1');
    // 2026-05-04 is Monday
    expect(matches(cron, new Date('2026-05-04T09:00:00').getTime())).toBe(true);
    expect(matches(cron, new Date('2026-05-03T09:00:00').getTime())).toBe(false);
  });
});

describe('nextRunAt', () => {
  it('next minute for * * * * *', () => {
    const cron = parseCron('* * * * *');
    const from = new Date('2026-05-03T10:00:30').getTime();
    const next = nextRunAt(cron, from);
    expect(next).toBe(new Date('2026-05-03T10:01:00').getTime());
  });

  it('next 5-step', () => {
    const cron = parseCron('*/5 * * * *');
    const from = new Date('2026-05-03T10:01:00').getTime();
    expect(nextRunAt(cron, from)).toBe(new Date('2026-05-03T10:05:00').getTime());
  });

  it('next daily 12:00 from after 12', () => {
    const cron = parseCron('0 12 * * *');
    const from = new Date('2026-05-03T13:00:00').getTime();
    expect(nextRunAt(cron, from)).toBe(new Date('2026-05-04T12:00:00').getTime());
  });

  it('always strictly after fromMs', () => {
    const cron = parseCron('* * * * *');
    const from = new Date('2026-05-03T10:00:00').getTime();
    expect(nextRunAt(cron, from)).toBe(new Date('2026-05-03T10:01:00').getTime());
  });
});
