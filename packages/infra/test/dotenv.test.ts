import { describe, it, expect, vi } from 'vitest';
import { loadDotenv } from '../src/dotenv.js';

describe('loadDotenv', () => {
  it('.env 파일이 없으면 에러 없이 통과한다', () => {
    expect(() => loadDotenv('/nonexistent/.env')).not.toThrow();
  });

  it('process.loadEnvFile을 호출한다', () => {
    const spy = vi.spyOn(process, 'loadEnvFile').mockImplementation(() => {});
    loadDotenv('/some/.env');
    expect(spy).toHaveBeenCalledWith('/some/.env');
    spy.mockRestore();
  });
});
