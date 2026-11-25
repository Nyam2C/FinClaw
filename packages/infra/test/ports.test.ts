import * as net from 'node:net';
import { describe, it, expect } from 'vitest';
import { PortInUseError } from '../src/errors.js';
import { assertPortAvailable } from '../src/ports.js';

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
