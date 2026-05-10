// Phase 30 A5: PII redaction for span attribute values.
//
// 적용 범위 — 문자열 값에 한정. 객체 / 배열 은 재귀.
// 패턴 — 이메일, SSN, 전화 (KR + 국제). 매우 보수적 (정확도 우선; false positive 최소).

const PATTERNS: Array<[RegExp, string]> = [
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[REDACTED_EMAIL]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[REDACTED_SSN]'],
  [/\b(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{4}\b/g, '[REDACTED_PHONE]'],
];

export function redactPII<T>(value: T): T {
  if (typeof value === 'string') {
    let out: string = value;
    for (const [re, sub] of PATTERNS) {
      out = out.replace(re, sub);
    }
    return out as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactPII(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = redactPII(v);
    }
    return out as unknown as T;
  }
  return value;
}
