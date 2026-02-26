// packages/infra/src/logger-transports.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import { getLogDir } from './paths.js';

export interface FileTransportConfig {
  enabled: boolean;
  path?: string;
  maxSizeMb?: number; // 기본: 10
  maxFiles?: number; // 기본: 5
}

/**
 * tslog에 파일 트랜스포트 부착
 *
 * JSON 라인 형식으로 파일에 로그 기록.
 * 간단한 크기 기반 로테이션 (maxSizeMb 초과 시 새 파일).
 */
export function attachFileTransport(
  logger: { attachTransport: (fn: (logObj: unknown) => void) => void },
  config: FileTransportConfig,
): (() => Promise<void>) | undefined {
  if (!config.enabled) {
    return undefined;
  }

  const logDir = config.path ?? getLogDir();
  fs.mkdirSync(logDir, { recursive: true });

  const logFile = path.join(logDir, 'finclaw.log');
  let stream = createWriteStream(logFile);
  let currentSize = getFileSize(logFile);
  const maxSize = (config.maxSizeMb ?? 10) * 1024 * 1024;
  const maxFiles = config.maxFiles ?? 5;

  logger.attachTransport((logObj: unknown) => {
    const line = JSON.stringify(logObj) + '\n';
    currentSize += Buffer.byteLength(line);

    if (currentSize > maxSize) {
      stream.end();
      rotateFiles(logFile, maxFiles);
      stream = createWriteStream(logFile);
      currentSize = 0;
    }

    stream.write(line);
  });

  // 현재 활성 스트림의 flush 콜백 반환 (closure로 stream 참조 추적)
  return () =>
    new Promise<void>((resolve) => {
      if (stream.writableFinished) {
        resolve();
      } else {
        stream.end(resolve);
      }
    });
}

function createWriteStream(filePath: string): fs.WriteStream {
  return fs.createWriteStream(filePath, { flags: 'a', mode: 0o600 });
}

function getFileSize(filePath: string): number {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

/** 로그 파일 로테이션: finclaw.log → finclaw.log.1 → ... → finclaw.log.N */
function rotateFiles(basePath: string, maxFiles: number): void {
  for (let i = maxFiles - 1; i >= 1; i--) {
    const from = i === 1 ? basePath : `${basePath}.${i - 1}`;
    const to = `${basePath}.${i}`;
    try {
      fs.renameSync(from, to);
    } catch {
      // 파일이 없으면 무시
    }
  }
}

/**
 * 모든 트랜스포트의 버퍼 플러시
 *
 * graceful shutdown 시 호출.
 * 반환된 Promise는 모든 스트림이 flush되면 resolve.
 */
export function createFlushFn(streams: fs.WriteStream[]): () => Promise<void> {
  return () =>
    Promise.all(
      streams.map(
        (s) => new Promise<void>((resolve) => (s.writableFinished ? resolve() : s.end(resolve))),
      ),
    ).then(() => {});
}
