// packages/infra/src/ports.ts
import * as net from 'node:net';
import { PortInUseError } from './errors.js';

/**
 * TCP 포트 가용성 확인
 *
 * 지정 포트에 바인딩 시도 후 즉시 해제.
 * 사용 중이면 PortInUseError throw.
 */
export async function assertPortAvailable(port: number, host = '0.0.0.0'): Promise<void> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new PortInUseError(port));
      } else {
        reject(err);
      }
    });

    server.listen(port, host, () => {
      server.close(() => resolve());
    });
  });
}

/**
 * 사용 가능한 포트 찾기
 *
 * 지정 포트부터 시작하여 사용 가능한 첫 포트를 반환.
 * maxTries 횟수만큼 시도.
 */
export async function findAvailablePort(
  startPort: number,
  maxTries = 10,
  host = '0.0.0.0',
): Promise<number> {
  for (let i = 0; i < maxTries; i++) {
    const port = startPort + i;
    try {
      await assertPortAvailable(port, host);
      return port;
    } catch (err) {
      if (!(err instanceof PortInUseError)) {
        throw err;
      }
      // 다음 포트 시도
    }
  }
  throw new PortInUseError(startPort, `ports ${startPort}-${startPort + maxTries - 1} all in use`);
}

/**
 * 포트 번호 유효성 검사
 */
export function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
