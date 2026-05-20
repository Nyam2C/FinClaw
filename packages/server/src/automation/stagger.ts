// packages/server/src/automation/stagger.ts

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
