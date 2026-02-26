// packages/infra/src/ports-inspect.ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface PortOccupant {
  pid: number;
  command: string;
  user?: string;
}

/**
 * 포트를 점유하고 있는 프로세스 정보 조회
 *
 * Linux/macOS: lsof -i :<port> -sTCP:LISTEN
 * 실패 시 undefined 반환 (권한 부족 등)
 */
export async function inspectPortOccupant(port: number): Promise<PortOccupant | undefined> {
  try {
    if (process.platform === 'win32') {
      return await inspectWindows(port);
    }
    return await inspectUnix(port);
  } catch {
    return undefined;
  }
}

async function inspectUnix(port: number): Promise<PortOccupant | undefined> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-i', `:${port}`, '-sTCP:LISTEN', '-n', '-P'], {
      timeout: 5000,
    });

    const lines = stdout.trim().split('\n');
    if (lines.length < 2) {
      return undefined;
    }

    // lsof 출력: COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME
    const parts = lines[1].split(/\s+/);
    return {
      command: parts[0],
      pid: Number(parts[1]),
      user: parts[2],
    };
  } catch {
    return undefined;
  }
}

async function inspectWindows(port: number): Promise<PortOccupant | undefined> {
  try {
    const { stdout } = await execFileAsync('netstat', ['-ano'], { timeout: 5000 });
    const lines = stdout.split('\n');
    const portLine = lines.find((l) => l.includes(`:${port}`) && l.includes('LISTENING'));
    if (!portLine) {
      return undefined;
    }

    const parts = portLine.trim().split(/\s+/);
    const pid = Number(parts[parts.length - 1]);
    return { pid, command: 'unknown' };
  } catch {
    return undefined;
  }
}

/**
 * 포트 점유 정보를 사람이 읽을 수 있는 문자열로 포맷
 */
export function formatPortOccupant(port: number, occupant: PortOccupant | undefined): string {
  if (!occupant) {
    return `Port ${port} is in use (unable to determine occupant)`;
  }
  const user = occupant.user ? ` by user ${occupant.user}` : '';
  return `Port ${port} is in use by ${occupant.command} (PID ${occupant.pid})${user}`;
}
