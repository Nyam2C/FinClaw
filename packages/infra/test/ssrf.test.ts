import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SsrfBlockedError } from '../src/errors.js';
import { isPrivateIp, validateUrlSafety } from '../src/ssrf.js';

// DNS 해석 모킹
vi.mock('node:dns/promises', () => ({
  resolve: vi.fn(),
}));

import { resolve as mockDnsResolve } from 'node:dns/promises';

describe('isPrivateIp', () => {
  it.each([
    ['10.0.0.1', true],
    ['10.255.255.255', true],
    ['172.16.0.1', true],
    ['172.31.255.255', true],
    ['172.15.0.1', false],
    ['172.32.0.1', false],
    ['192.168.0.1', true],
    ['192.168.255.255', true],
    ['127.0.0.1', true],
    ['169.254.0.1', true],
    ['100.64.0.1', true], // CGNAT
    ['100.127.255.255', true], // CGNAT
    ['100.63.255.255', false], // CGNAT 경계 아래
    ['0.0.0.0', true],
    ['8.8.8.8', false],
    ['1.1.1.1', false],
  ])('isPrivateIp(%s) → %s', (ip, expected) => {
    expect(isPrivateIp(ip)).toBe(expected);
  });

  it('IPv4-mapped-IPv6를 처리한다', () => {
    expect(isPrivateIp('::ffff:10.0.0.1')).toBe(true);
    expect(isPrivateIp('::ffff:8.8.8.8')).toBe(false);
  });

  it('IPv6 사설 주소를 판별한다', () => {
    expect(isPrivateIp('::1')).toBe(true);
    expect(isPrivateIp('fe80::1')).toBe(true);
    expect(isPrivateIp('fc00::1')).toBe(true);
    expect(isPrivateIp('fd00::1')).toBe(true);
    expect(isPrivateIp('2001:db8::1')).toBe(false);
  });
});

describe('validateUrlSafety', () => {
  beforeEach(() => {
    vi.mocked(mockDnsResolve).mockReset();
  });

  it('공인 IP로 해석되면 IP를 반환한다', async () => {
    vi.mocked(mockDnsResolve).mockResolvedValue(['93.184.216.34'] as never);
    const ip = await validateUrlSafety('https://example.com/path');
    expect(ip).toBe('93.184.216.34');
  });

  it('사설 IP로 해석되면 SsrfBlockedError를 던진다', async () => {
    vi.mocked(mockDnsResolve).mockResolvedValue(['10.0.0.1'] as never);
    await expect(validateUrlSafety('https://evil.com')).rejects.toThrow(SsrfBlockedError);
  });

  it('localhost를 hostname 수준에서 차단한다', async () => {
    await expect(validateUrlSafety('https://localhost:8080')).rejects.toThrow(SsrfBlockedError);
  });

  it('.local 도메인을 차단한다', async () => {
    await expect(validateUrlSafety('https://server.local')).rejects.toThrow(SsrfBlockedError);
  });

  it('localhost를 부분 포함하는 호스트명은 차단하지 않는다', async () => {
    vi.mocked(mockDnsResolve).mockResolvedValue(['93.184.216.34'] as never);
    const ip = await validateUrlSafety('https://evillocalhost.com');
    expect(ip).toBe('93.184.216.34');
  });

  it('allowPrivateNetwork: true에서 사설 IP를 허용한다', async () => {
    vi.mocked(mockDnsResolve).mockResolvedValue(['10.0.0.1'] as never);
    const ip = await validateUrlSafety('https://internal.dev', {
      allowPrivateNetwork: true,
    });
    expect(ip).toBe('10.0.0.1');
  });

  it('hostnameAllowlist에 포함된 호스트를 통과시킨다', async () => {
    vi.mocked(mockDnsResolve).mockResolvedValue(['10.0.0.1'] as never);
    const ip = await validateUrlSafety('https://trusted.internal', {
      hostnameAllowlist: ['trusted.internal'],
    });
    expect(ip).toBe('10.0.0.1');
  });
});
