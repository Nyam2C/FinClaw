// packages/server/src/automation/cron.ts
// Phase 28 B: 5필드 cron (분 시 일 월 요일).
// 지원: '*', '*/N', 'M-N', 'M,N,O' 단순 조합. 한 필드당 number[].
// 비지원: 'L'(last day), 'W'(weekday), '?'.

export interface CronExpression {
  /** 0-59 */
  readonly minute: readonly number[];
  /** 0-23 */
  readonly hour: readonly number[];
  /** 1-31 */
  readonly dayOfMonth: readonly number[];
  /** 1-12 */
  readonly month: readonly number[];
  /** 0-6 (0=일) */
  readonly dayOfWeek: readonly number[];
}

export class CronParseError extends Error {
  constructor(
    message: string,
    public readonly expr: string,
    public readonly field: string,
  ) {
    super(`cron parse error in ${field}: ${message} (expr='${expr}')`);
    this.name = 'CronParseError';
  }
}

interface FieldRange {
  readonly min: number;
  readonly max: number;
}

const FIELD_RANGES = {
  minute: { min: 0, max: 59 },
  hour: { min: 0, max: 23 },
  dayOfMonth: { min: 1, max: 31 },
  month: { min: 1, max: 12 },
  dayOfWeek: { min: 0, max: 6 },
} as const;

function expandField(token: string, range: FieldRange, expr: string, field: string): number[] {
  const out = new Set<number>();
  for (const part of token.split(',')) {
    if (part === '*') {
      for (let i = range.min; i <= range.max; i++) {
        out.add(i);
      }
      continue;
    }
    const stepMatch = part.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (stepMatch) {
      const base = stepMatch[1];
      const stepStr = stepMatch[2];
      const step = Number(stepStr);
      if (!Number.isInteger(step) || step <= 0) {
        throw new CronParseError(`invalid step: ${stepStr}`, expr, field);
      }
      let lo = range.min;
      let hi = range.max;
      if (base !== '*') {
        const r = base.split('-');
        lo = Number(r[0]);
        hi = r[1] !== undefined ? Number(r[1]) : range.max;
      }
      for (let i = lo; i <= hi; i += step) {
        out.add(i);
      }
      continue;
    }
    const rangeMatch = part.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const lo = Number(rangeMatch[1]);
      const hi = Number(rangeMatch[2]);
      if (lo > hi) {
        throw new CronParseError(`reversed range: ${part}`, expr, field);
      }
      for (let i = lo; i <= hi; i++) {
        out.add(i);
      }
      continue;
    }
    if (/^\d+$/.test(part)) {
      out.add(Number(part));
      continue;
    }
    throw new CronParseError(`unrecognized token: ${part}`, expr, field);
  }
  const arr = [...out].toSorted((a, b) => a - b);
  for (const v of arr) {
    if (v < range.min || v > range.max) {
      throw new CronParseError(`value ${v} out of range [${range.min}, ${range.max}]`, expr, field);
    }
  }
  if (arr.length === 0) {
    throw new CronParseError('empty field', expr, field);
  }
  return arr;
}

export function parseCron(expr: string): CronExpression {
  const tokens = expr.trim().split(/\s+/);
  if (tokens.length !== 5) {
    throw new CronParseError(`expected 5 fields, got ${tokens.length}`, expr, 'all');
  }
  return {
    minute: expandField(tokens[0], FIELD_RANGES.minute, expr, 'minute'),
    hour: expandField(tokens[1], FIELD_RANGES.hour, expr, 'hour'),
    dayOfMonth: expandField(tokens[2], FIELD_RANGES.dayOfMonth, expr, 'dayOfMonth'),
    month: expandField(tokens[3], FIELD_RANGES.month, expr, 'month'),
    dayOfWeek: expandField(tokens[4], FIELD_RANGES.dayOfWeek, expr, 'dayOfWeek'),
  };
}

/** 주어진 시각이 cron 에 매칭되는지 검사. 초/밀리초 무시 (분 단위). */
export function matches(cron: CronExpression, dateMs: number): boolean {
  const d = new Date(dateMs);
  if (!cron.minute.includes(d.getMinutes())) {
    return false;
  }
  if (!cron.hour.includes(d.getHours())) {
    return false;
  }
  if (!cron.month.includes(d.getMonth() + 1)) {
    return false;
  }
  // POSIX cron: dayOfMonth 와 dayOfWeek 모두 비-기본(*아님)인 경우 OR. 둘 중 하나만 비기본이면 그것만.
  const dom = cron.dayOfMonth;
  const dow = cron.dayOfWeek;
  const domAll = dom.length === 31;
  const dowAll = dow.length === 7;
  if (domAll && dowAll) {
    return true;
  }
  if (!domAll && !dowAll) {
    return dom.includes(d.getDate()) || dow.includes(d.getDay());
  }
  if (!domAll) {
    return dom.includes(d.getDate());
  }
  return dow.includes(d.getDay());
}

/** fromMs 보다 엄격히 큰(>) 다음 매칭 시각. 1년 내 매칭 못 찾으면 null (실용상 미발생). */
export function nextRunAt(cron: CronExpression, fromMs: number): number | null {
  // 분 경계로 올림 후 +1분.
  const start = new Date(fromMs);
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = start.getTime() + 366 * 24 * 60 * 60 * 1000;
  let cursor = start.getTime();
  while (cursor < limit) {
    if (matches(cron, cursor)) {
      return cursor;
    }
    cursor += 60_000;
  }
  return null;
}
