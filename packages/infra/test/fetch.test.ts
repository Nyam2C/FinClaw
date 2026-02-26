import { describe, it, expect, vi, beforeEach } from 'vitest';
import { safeFetch } from '../src/fetch.js';

// ssrf 모듈 모킹 (DNS 호출 방지)
vi.mock('../src/ssrf.js', () => ({
  validateUrlSafety: vi.fn().mockResolvedValue('93.184.216.34'),
}));

// 글로벌 fetch 모킹
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { validateUrlSafety } from '../src/ssrf.js';

describe('safeFetch', () => {
  beforeEach(() => {
    vi.mocked(validateUrlSafety).mockResolvedValue('93.184.216.34');
    mockFetch.mockReset();
  });

  it('SSRF 검증을 호출한다', async () => {
    mockFetch.mockResolvedValue(new Response('ok'));
    await safeFetch('https://example.com');
    expect(validateUrlSafety).toHaveBeenCalledWith('https://example.com', undefined);
  });

  it('redirect: error가 기본 적용된다', async () => {
    mockFetch.mockResolvedValue(new Response('ok'));
    await safeFetch('https://example.com');
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('allowRedirect: true에서 redirect: follow가 적용된다', async () => {
    mockFetch.mockResolvedValue(new Response('ok'));
    await safeFetch('https://example.com', { allowRedirect: true });
    expect(mockFetch).toHaveBeenCalledWith(
      'https://example.com',
      expect.objectContaining({ redirect: 'follow' }),
    );
  });

  it('AbortSignal.timeout이 적용된다', async () => {
    mockFetch.mockResolvedValue(new Response('ok'));
    await safeFetch('https://example.com', { timeoutMs: 5000 });
    const callArgs = mockFetch.mock.calls[0][1];
    expect(callArgs.signal).toBeDefined();
  });

  it('SSRF 검증 실패 시 에러를 전파한다', async () => {
    vi.mocked(validateUrlSafety).mockRejectedValue(new Error('SSRF blocked'));
    await expect(safeFetch('https://evil.com')).rejects.toThrow('SSRF blocked');
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
