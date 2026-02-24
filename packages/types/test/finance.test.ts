import { createTickerSymbol, createCurrencyCode } from '@finclaw/types';
import { describe, it, expect } from 'vitest';

describe('createTickerSymbol', () => {
  it('대문자로 정규화한다', () => {
    const symbol = createTickerSymbol('aapl');
    expect(symbol).toBe('AAPL');
  });

  it('앞뒤 공백을 제거한다', () => {
    const symbol = createTickerSymbol('  BTC-USD  ');
    expect(symbol).toBe('BTC-USD');
  });

  it('이미 대문자인 심볼을 그대로 반환한다', () => {
    const symbol = createTickerSymbol('005930.KS');
    expect(symbol).toBe('005930.KS');
  });
});

describe('createCurrencyCode', () => {
  it('유효한 ISO 4217 코드를 생성한다', () => {
    const code = createCurrencyCode('usd');
    expect(code).toBe('USD');
  });

  it('앞뒤 공백을 제거한다', () => {
    const code = createCurrencyCode('  krw  ');
    expect(code).toBe('KRW');
  });

  it('4글자 코드에 에러를 던진다', () => {
    expect(() => createCurrencyCode('ABCD')).toThrow('Invalid currency code');
  });

  it('2글자 코드에 에러를 던진다', () => {
    expect(() => createCurrencyCode('US')).toThrow('Invalid currency code');
  });

  it('숫자 포함 코드에 에러를 던진다', () => {
    expect(() => createCurrencyCode('U1D')).toThrow('Invalid currency code');
  });
});
