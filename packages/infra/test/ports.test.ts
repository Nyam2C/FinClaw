import * as net from 'node:net';
import { describe, it, expect } from 'vitest';
import { PortInUseError } from '../src/errors.js';
import { assertPortAvailable, findAvailablePort, isValidPort } from '../src/ports.js';

describe('assertPortAvailable', () => {
  it('사용되지 않는 포트에서 통과한다', async () => {
    // 높은 포트 번호 사용 (충돌 가능성 낮음)
    await expect(assertPortAvailable(49999)).resolves.toBeUndefined();
  });

  it('사용 중인 포트에서 PortInUseError를 던진다', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as net.AddressInfo).port;

    try {
      await expect(assertPortAvailable(port)).rejects.toThrow(PortInUseError);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('findAvailablePort', () => {
  it('사용 가능한 포트를 반환한다', async () => {
    const port = await findAvailablePort(49990, 10);
    expect(port).toBeGreaterThanOrEqual(49990);
    expect(port).toBeLessThanOrEqual(49999);
  });

  it('점유된 포트를 건너뛴다', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const occupiedPort = (server.address() as net.AddressInfo).port;

    try {
      const port = await findAvailablePort(occupiedPort, 5);
      expect(port).toBeGreaterThan(occupiedPort);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('isValidPort', () => {
  it.each([
    [1, true],
    [80, true],
    [8080, true],
    [65535, true],
    [0, false],
    [-1, false],
    [65536, false],
    [1.5, false],
    [NaN, false],
  ])('isValidPort(%s) → %s', (port, expected) => {
    expect(isValidPort(port)).toBe(expected);
  });
});
