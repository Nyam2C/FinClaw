// packages/server/src/automation/stagger.ts
import { createHash } from 'node:crypto';
import { nextRunAt as computeNextRunAt, parseCron } from '@finclaw/infra';

export const DEFAULT_TOP_OF_HOUR_STAGGER_MS = 5 * 60 * 1000;

function parseCronFields(expr: string): string[] {
  return expr.trim().split(/\s+/).filter(Boolean);
}

export function isRecurringTopOfHourCronExpr(expr: string): boolean {
  const fields = parseCronFields(expr);
  if (fields.length === 5) {
    const [minuteField, hourField] = fields;
    return minuteField === '0' && hourField.includes('*');
  }
  if (fields.length === 6) {
    const [secondField, minuteField, hourField] = fields;
    return secondField === '0' && minuteField === '0' && hourField.includes('*');
  }
  return false;
}

export function normalizeCronStaggerMs(raw: unknown): number | undefined {
  const numeric =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && raw.trim()
        ? Number(raw)
        : Number.NaN;
  if (!Number.isFinite(numeric)) {
    return undefined;
  }
  return Math.max(0, Math.floor(numeric));
}

export function resolveDefaultCronStaggerMs(expr: string): number | undefined {
  return isRecurringTopOfHourCronExpr(expr) ? DEFAULT_TOP_OF_HOUR_STAGGER_MS : undefined;
}

export function resolveCronStaggerMs(schedule: {
  cron?: string;
  staggerMs?: number | string;
}): number {
  const explicit = normalizeCronStaggerMs(schedule.staggerMs);
  if (explicit !== undefined) {
    return explicit;
  }
  return resolveDefaultCronStaggerMs(schedule.cron ?? '') ?? 0;
}

/** B5: schedule.id 해시로 결정적 오프셋. 같은 id → 같은 오프셋, stagger 0 → 0. */
export function staggerOffsetMs(scheduleId: string, staggerMs: number): number {
  if (staggerMs <= 0) {
    return 0;
  }
  return createHash('sha256').update(scheduleId).digest().readUInt32BE(0) % staggerMs;
}

/**
 * 다음 실행 시각의 단일 지점 — cron 다음 발화 + 결정적 stagger 오프셋.
 * ponytail: 오프셋 < staggerMs(기본 5분) < cron 간격(정각 cron 은 1h) 을 가정. 명시 staggerMs 가 간격보다 크면 발화가 밀린다.
 * 파싱 실패는 throw (호출자가 기존처럼 처리).
 */
export function nextStaggeredRunAt(
  schedule: { readonly id: string; readonly cron: string; readonly staggerMs?: number | string },
  fromMs: number,
): number | null {
  const next = computeNextRunAt(parseCron(schedule.cron), fromMs);
  return next === null ? null : next + staggerOffsetMs(schedule.id, resolveCronStaggerMs(schedule));
}
