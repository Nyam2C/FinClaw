import { execSync } from 'node:child_process';
// packages/server/src/services/daemon/systemd.ts
import { writeFile } from 'node:fs/promises';

/**
 * systemd 사용 가능 여부 감지.
 * WSL 환경에서는 systemd가 비활성화된 경우가 많으므로 힌트 제공.
 */
export function isSystemdAvailable(): { available: boolean; hint?: string } {
  if (process.platform !== 'linux') {
    return { available: false, hint: 'systemd는 Linux에서만 사용 가능합니다.' };
  }

  if (process.env.WSL_DISTRO_NAME) {
    try {
      execSync('systemctl --version', { stdio: 'ignore' });
      return {
        available: true,
        hint: 'WSL에서 systemd 활성화됨. /etc/wsl.conf에서 [boot] systemd=true 확인.',
      };
    } catch {
      return {
        available: false,
        hint: 'WSL에서 systemd가 비활성화되어 있습니다. /etc/wsl.conf에 [boot] systemd=true를 추가하세요.',
      };
    }
  }

  try {
    execSync('systemctl --version', { stdio: 'ignore' });
    return { available: true };
  } catch {
    return { available: false, hint: 'systemd를 찾을 수 없습니다. init 시스템을 확인하세요.' };
  }
}

export interface SystemdServiceOptions {
  readonly name?: string;
  readonly execPath: string;
  readonly workingDir: string;
  readonly envFile?: string;
  readonly outputPath: string;
}

/**
 * systemd 서비스 파일 생성.
 * Restart=on-failure (always 대신 — 설정 오류 시 무한 재시작 방지)
 */
export async function generateSystemdService(options: SystemdServiceOptions): Promise<void> {
  const { name = 'finclaw', execPath, workingDir, envFile, outputPath } = options;

  const unit = `[Unit]
Description=FinClaw Financial AI Assistant
After=network.target

[Service]
Type=simple
ExecStart=${execPath}
WorkingDirectory=${workingDir}
${envFile ? `EnvironmentFile=${envFile}` : '# EnvironmentFile= (not configured)'}
Restart=on-failure
RestartSec=5
StandardOutput=journal
StandardError=journal
SyslogIdentifier=${name}

[Install]
WantedBy=multi-user.target
`;

  await writeFile(outputPath, unit, 'utf-8');
}
