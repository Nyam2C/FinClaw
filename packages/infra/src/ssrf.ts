// packages/infra/src/ssrf.ts
import { resolve as dnsResolve } from 'node:dns/promises';
import { SsrfBlockedError } from './errors.js';

/** SSRF 정책 설정 */
export interface SsrfPolicy {
  /** 사설 네트워크 허용 (테스트/개발용, 기본: false) */
  allowPrivateNetwork?: boolean;
  /** 추가 허용 호스트명 (정책 우회) */
  hostnameAllowlist?: string[];
}

/**
 * DNS 핀닝 기반 SSRF 방지
 *
 * 1. DNS 해석 → 모든 주소가 사설 IP인지 검사
 * 2. 검증된 IP를 핀닝하여 DNS 재해석 방지 (TOCTOU 공격 차단)
 */
export async function validateUrlSafety(url: string, policy?: SsrfPolicy): Promise<string> {
  const { hostname } = new URL(url);

  // 허용 목록 우선 통과
  if (policy?.hostnameAllowlist?.includes(hostname)) {
    const addresses = await dnsResolve(hostname);
    return addresses[0];
  }

  // 호스트명 수준 차단
  if (BLOCKED_HOSTNAMES.some((pattern) => hostname.endsWith(pattern))) {
    throw new SsrfBlockedError(hostname, hostname);
  }

  // DNS 해석 및 IP 검사
  const addresses = await dnsResolve(hostname);
  if (!policy?.allowPrivateNetwork) {
    for (const addr of addresses) {
      if (isPrivateIp(addr)) {
        throw new SsrfBlockedError(hostname, addr);
      }
    }
  }

  return addresses[0]; // 핀닝용 IP 반환
}

/** 사설 IP 판별 — IPv4, IPv6, IPv4-mapped-IPv6 모두 처리 */
export function isPrivateIp(ip: string): boolean {
  if (ip.startsWith('::ffff:')) {
    return isPrivateIpv4(ip.slice(7));
  }
  if (ip.includes(':')) {
    return isPrivateIpv6(ip);
  }
  return isPrivateIpv4(ip);
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 10 || // 10.0.0.0/8
    a === 127 || // 127.0.0.0/8
    (a === 172 && b >= 16 && b <= 31) || // 172.16.0.0/12
    (a === 192 && b === 168) || // 192.168.0.0/16
    (a === 169 && b === 254) || // 169.254.0.0/16 (link-local)
    (a === 100 && b >= 64 && b <= 127) || // 100.64.0.0/10 (CGNAT)
    a === 0 // 0.0.0.0/8
  );
}

function isPrivateIpv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return (
    normalized === '::1' || // loopback
    normalized.startsWith('fe80:') || // link-local
    normalized.startsWith('fc') || // unique local
    normalized.startsWith('fd') // unique local
  );
}

const BLOCKED_HOSTNAMES = ['localhost', '.local', '.internal', '.localhost'];
