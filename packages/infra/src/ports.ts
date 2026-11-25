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
