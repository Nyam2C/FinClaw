// packages/server/src/services/security/redaction.test.ts
import { describe, it, expect } from 'vitest';
import { redactSensitiveText, redactObject, REDACTION_PATTERNS } from './redaction.js';

describe('redactSensitiveText', () => {
  it('Anthropic API 키를 마스킹한다', () => {
    const input = 'key: sk-ant-abcdefghijklmnopqrstuvwx';
    expect(redactSensitiveText(input)).toContain('[REDACTED_ANTHROPIC_KEY]');
    expect(redactSensitiveText(input)).not.toContain('abcdefghij');
  });

  it('OpenAI API 키를 마스킹한다', () => {
    const input = 'key: sk-abcdefghijklmnopqrstuvwx';
    expect(redactSensitiveText(input)).toContain('[REDACTED_OPENAI_KEY]');
  });

  it('Alpha Vantage 키를 마스킹한다', () => {
    const input = 'ALPHA_VANTAGE_API_KEY=ABCDEF1234567890';
    expect(redactSensitiveText(input)).toContain('[REDACTED]');
    expect(redactSensitiveText(input)).not.toContain('ABCDEF1234567890');
  });

  it('CoinGecko 키를 마스킹한다', () => {
    const input = 'key: CG-abcdefghijklmnopqrstuvwxyz';
    expect(redactSensitiveText(input)).toContain('[REDACTED_COINGECKO_KEY]');
  });

  it('거래소 API secret을 마스킹한다', () => {
    const input = 'binance_secret=abcdefghijklmnopqrstuvwx';
    expect(redactSensitiveText(input)).toContain('[REDACTED_EXCHANGE_SECRET]');
  });

  it('Bearer 토큰을 마스킹한다', () => {
    const input = 'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.test.sig';
    const result = redactSensitiveText(input);
    expect(result).not.toContain('eyJhbGciOiJIUzI1NiJ9');
  });

  it('JWT를 마스킹한다', () => {
    const input = 'token=eyJhbGciOiJIUzI1NiJ9.eyJ1c2VyIjoiYWRtaW4ifQ.signaturehere';
    expect(redactSensitiveText(input)).toContain('[REDACTED_JWT]');
  });

  it('PEM 개인 키를 마스킹한다', () => {
    const input = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg...\n-----END PRIVATE KEY-----';
    expect(redactSensitiveText(input)).toBe('[REDACTED_PRIVATE_KEY]');
  });

  it('Discord 봇 토큰을 마스킹한다', () => {
    // Build fake token from parts to avoid GitHub push protection false positive
    const input = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OQ', 'AbCdEf', 'abcdefghijklmnopqrstuvwxyz1234'].join(
      '.',
    );
    expect(redactSensitiveText(input)).toContain('[REDACTED_DISCORD_TOKEN]');
  });

  it('URL 파라미터의 API 키를 마스킹한다', () => {
    const input = 'https://api.example.com/data?api_key=secretvalue123&format=json';
    expect(redactSensitiveText(input)).toContain('[REDACTED]');
    expect(redactSensitiveText(input)).not.toContain('secretvalue123');
  });

  it('일반 텍스트를 변경하지 않는다 (false positive 방지)', () => {
    const input = 'Hello, this is a normal log message with no secrets.';
    expect(redactSensitiveText(input)).toBe(input);
  });

  it('$1 백레퍼런스가 키 이름을 보존한다', () => {
    const input = 'api_key=sk-verylongapikeythatshouldbereplaced';
    const result = redactSensitiveText(input);
    expect(result).toContain('api_key');
  });

  it('연속 호출에서 regex lastIndex 문제가 없다', () => {
    const input = 'key: sk-ant-abcdefghijklmnopqrstuvwx';
    redactSensitiveText(input);
    const result = redactSensitiveText(input);
    expect(result).toContain('[REDACTED_ANTHROPIC_KEY]');
  });
});

describe('redactObject', () => {
  it('중첩 객체의 문자열 값을 마스킹한다', () => {
    const obj = {
      config: {
        apiKey: 'sk-ant-abcdefghijklmnopqrstuvwx',
        name: 'test',
      },
    };
    const result = redactObject(obj);
    expect(result.config.apiKey).toContain('[REDACTED_ANTHROPIC_KEY]');
    expect(result.config.name).toBe('test');
  });

  it('배열 내 문자열도 마스킹한다', () => {
    const arr = ['normal', 'key: sk-ant-abcdefghijklmnopqrstuvwx'];
    const result = redactObject(arr);
    expect(result[0]).toBe('normal');
    expect(result[1]).toContain('[REDACTED_ANTHROPIC_KEY]');
  });

  it('비문자열 값은 변경하지 않는다', () => {
    expect(redactObject(42)).toBe(42);
    expect(redactObject(null)).toBe(null);
    expect(redactObject(true)).toBe(true);
  });
});

describe('REDACTION_PATTERNS', () => {
  it('13개 이상의 패턴이 등록되어 있다', () => {
    expect(REDACTION_PATTERNS.length).toBeGreaterThanOrEqual(13);
  });

  it('모든 패턴에 name, pattern, replacement가 있다', () => {
    for (const p of REDACTION_PATTERNS) {
      expect(p.name).toBeTruthy();
      expect(p.pattern).toBeInstanceOf(RegExp);
      expect(typeof p.replacement).toBe('string');
    }
  });
});
