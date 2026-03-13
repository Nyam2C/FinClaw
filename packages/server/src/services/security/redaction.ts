// packages/server/src/services/security/redaction.ts

/** 리다이렉션 패턴 정의 */
export interface RedactionPattern {
  readonly name: string;
  readonly pattern: RegExp;
  readonly replacement: string;
}

/**
 * 금융 API 키를 포함한 13+ 리다이렉션 패턴.
 * 순서 중요: 구체적 패턴이 범용 패턴보다 먼저 적용되어야 한다.
 */
export const REDACTION_PATTERNS: RedactionPattern[] = [
  // ── PEM 개인 키 (멀티라인이므로 최우선) ──
  {
    name: 'pem_private_key',
    pattern:
      /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g,
    replacement: '[REDACTED_PRIVATE_KEY]',
  },

  // ── JWT (구체적 패턴 — generic보다 먼저) ──
  {
    name: 'jwt_token',
    pattern: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g,
    replacement: '[REDACTED_JWT]',
  },

  // ── Anthropic ──
  {
    name: 'anthropic_api_key',
    pattern: /sk-ant-[A-Za-z0-9-]{20,}/g,
    replacement: '[REDACTED_ANTHROPIC_KEY]',
  },

  // ── OpenAI ──
  {
    name: 'openai_api_key',
    pattern: /sk-[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED_OPENAI_KEY]',
  },

  // ── CoinGecko (금융) ──
  {
    name: 'coingecko_key',
    pattern: /CG-[A-Za-z0-9]{20,}/g,
    replacement: '[REDACTED_COINGECKO_KEY]',
  },

  // ── Discord 봇 토큰 ──
  {
    name: 'discord_token',
    pattern: /[MN][A-Za-z\d]{23,28}\.[A-Za-z\d-_]{6}\.[A-Za-z\d-_]{27,}/g,
    replacement: '[REDACTED_DISCORD_TOKEN]',
  },

  // ── Alpha Vantage (금융) ──
  {
    name: 'alpha_vantage_key',
    pattern:
      /(?:ALPHA_VANTAGE|alphavantage)[_-]?(?:API[_-]?)?KEY\s*[:=]\s*["']?[A-Z0-9]{10,}["']?/gi,
    replacement: 'ALPHA_VANTAGE_KEY=[REDACTED]',
  },

  // ── 거래소 API (금융 — generic보다 먼저) ──
  {
    name: 'exchange_api_secret',
    pattern:
      /(binance|upbit|bithumb|coinbase)[_-]?(?:secret|api[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9+/]{20,}["']?/gi,
    replacement: '$1=[REDACTED_EXCHANGE_SECRET]',
  },

  // ── Bearer 토큰 ──
  {
    name: 'bearer_token',
    pattern: /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    replacement: 'Bearer [REDACTED]',
  },

  // ── Authorization 헤더 ──
  {
    name: 'authorization_header',
    pattern: /Authorization:\s*\S+/gi,
    replacement: 'Authorization: [REDACTED]',
  },

  // ── URL 파라미터 API 키 ──
  {
    name: 'api_key_param',
    pattern: /[?&](?:api_?key|apikey|access_?token)=[^&\s]+/gi,
    replacement: '?api_key=[REDACTED]',
  },

  // ── 환경변수 내 비밀 ──
  {
    name: 'env_secret',
    pattern: /(SECRET|PASSWORD|CREDENTIAL|PRIVATE)(?:_KEY)?\s*=\s*["']?[^\s"']+["']?/gi,
    replacement: '$1=[REDACTED]',
  },

  // ── 범용 API 키/토큰 (가장 마지막 — 구체적 패턴에서 놓친 것만 처리) ──
  {
    name: 'generic_api_key',
    pattern: /(api[_-]?key|secret|token|password)\s*[:=]\s*["']?[A-Za-z0-9\-._]{20,}["']?/gi,
    replacement: '$1=[REDACTED]',
  },
];

/**
 * 텍스트에서 민감한 자격 증명을 마스킹한다.
 * 로그 출력, 에러 메시지, 진단 리포트에서 사용.
 */
export function redactSensitiveText(text: string): string {
  let result = text;
  for (const { pattern, replacement } of REDACTION_PATTERNS) {
    // RegExp에 g 플래그가 있으면 lastIndex 리셋 필요
    pattern.lastIndex = 0;
    result = result.replace(pattern, replacement);
  }
  return result;
}

/**
 * 객체의 모든 문자열 값에서 민감한 정보를 마스킹한다.
 */
export function redactObject<T>(obj: T): T {
  return redactObjectInner(obj, new WeakSet());
}

function redactObjectInner<T>(obj: T, seen: WeakSet<object>): T {
  if (typeof obj === 'string') {
    return redactSensitiveText(obj) as T;
  }
  if (Array.isArray(obj)) {
    if (seen.has(obj)) {
      return '[Circular]' as T;
    }
    seen.add(obj);
    return obj.map((item) => redactObjectInner(item, seen)) as T;
  }
  if (obj && typeof obj === 'object') {
    if (seen.has(obj)) {
      return '[Circular]' as T;
    }
    seen.add(obj);
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = redactObjectInner(value, seen);
    }
    return result as T;
  }
  return obj;
}
