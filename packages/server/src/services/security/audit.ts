// packages/server/src/services/security/audit.ts
import { stat } from 'node:fs/promises';

/** 보안 감사 결과 항목 */
export interface SecurityAuditFinding {
  readonly checkId: string;
  readonly severity: 'info' | 'warn' | 'critical';
  readonly title: string;
  readonly detail: string;
  readonly remediation?: string;
}

/** 보안 감사 리포트 */
export interface SecurityAuditReport {
  readonly findings: SecurityAuditFinding[];
  readonly summary: {
    readonly critical: number;
    readonly warn: number;
    readonly info: number;
  };
  readonly timestamp: number;
}

/** 보안 감사 옵션 */
export interface SecurityAuditOptions {
  readonly checkApiKeys?: boolean;
  readonly checkFilePermissions?: boolean;
  readonly checkEnvironment?: boolean;
}

/**
 * 보안 감사를 실행한다.
 * 금융 데이터를 다루는 FinClaw에 특화된 보안 검사 수행.
 */
export async function runSecurityAudit(
  options: SecurityAuditOptions = {},
): Promise<SecurityAuditReport> {
  const findings: SecurityAuditFinding[] = [];

  if (options.checkApiKeys !== false) {
    findings.push(...collectApiKeyFindings());
  }

  if (options.checkFilePermissions !== false) {
    findings.push(...(await collectFilePermissionFindings()));
  }

  if (options.checkEnvironment !== false) {
    findings.push(...collectEnvironmentFindings());
  }

  const summary = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warn: findings.filter((f) => f.severity === 'warn').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };

  return { findings, summary, timestamp: Date.now() };
}

function collectApiKeyFindings(): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];

  // 필수 키 존재 여부
  const requiredKeys: Array<{ env: string; name: string }> = [
    { env: 'ANTHROPIC_API_KEY', name: 'Anthropic API 키' },
    { env: 'DISCORD_TOKEN', name: 'Discord 봇 토큰' },
  ];
  for (const { env, name } of requiredKeys) {
    if (!process.env[env]) {
      findings.push({
        checkId: `api_key.missing.${env.toLowerCase()}`,
        severity: 'critical',
        title: `필수 API 키 미설정: ${name}`,
        detail: `환경변수 ${env}가 설정되지 않았습니다.`,
        remediation: `.env 파일에 ${env}를 설정하거나 환경변수로 전달하세요.`,
      });
    }
  }

  // 선택 키 안내
  const optionalKeys: Array<{ env: string; name: string }> = [
    { env: 'ALPHA_VANTAGE_API_KEY', name: 'Alpha Vantage' },
    { env: 'COINGECKO_API_KEY', name: 'CoinGecko' },
  ];
  for (const { env, name } of optionalKeys) {
    if (!process.env[env]) {
      findings.push({
        checkId: `api_key.optional.${env.toLowerCase()}`,
        severity: 'info',
        title: `선택 API 키 미설정: ${name}`,
        detail: `${name} 키(${env})가 없으면 해당 데이터 소스를 사용할 수 없습니다.`,
      });
    }
  }

  // 위험 환경변수 감지
  const dangerousEnvVars = [
    'LD_PRELOAD',
    'LD_LIBRARY_PATH',
    'NODE_OPTIONS',
    'NODE_DEBUG',
    'UV_THREADPOOL_SIZE',
  ];
  for (const envVar of dangerousEnvVars) {
    if (process.env[envVar]) {
      findings.push({
        checkId: `env.dangerous.${envVar.toLowerCase()}`,
        severity: 'warn',
        title: `위험한 환경변수 감지: ${envVar}`,
        detail: `${envVar}가 설정되어 있습니다. 보안 위험을 초래할 수 있습니다.`,
        remediation: `${envVar} 환경변수를 제거하거나, 꼭 필요한 경우 값을 검증하세요.`,
      });
    }
  }

  return findings;
}

async function collectFilePermissionFindings(): Promise<SecurityAuditFinding[]> {
  const findings: SecurityAuditFinding[] = [];

  // WSL/Windows 환경에서는 POSIX 퍼미션 검사 무의미
  if (process.platform === 'win32' || process.env.WSL_DISTRO_NAME) {
    findings.push({
      checkId: 'file_perm.skipped',
      severity: 'info',
      title: '파일 퍼미션 검사 생략',
      detail: 'WSL/Windows 환경에서는 POSIX 파일 퍼미션이 적용되지 않습니다.',
    });
    return findings;
  }

  const sensitiveFiles = ['.env', 'finclaw.db', 'finclaw.db-wal', 'finclaw.db-shm'];
  for (const file of sensitiveFiles) {
    try {
      const st = await stat(file);
      const mode = st.mode & 0o777;

      if (mode & 0o004) {
        findings.push({
          checkId: `file_perm.world_readable.${file}`,
          severity: 'critical',
          title: `민감 파일 world-readable: ${file}`,
          detail: `${file}이 제3자에게 읽기 가능합니다 (mode: ${mode.toString(8)}).`,
          remediation: `chmod 600 ${file}`,
        });
      } else if (mode & 0o040) {
        findings.push({
          checkId: `file_perm.group_readable.${file}`,
          severity: 'warn',
          title: `민감 파일 group-readable: ${file}`,
          detail: `${file}이 그룹에게 읽기 가능합니다 (mode: ${mode.toString(8)}).`,
          remediation: `chmod 600 ${file}`,
        });
      }
    } catch {
      // 파일 없음 — 무시
    }
  }

  return findings;
}

function collectEnvironmentFindings(): SecurityAuditFinding[] {
  const findings: SecurityAuditFinding[] = [];

  if (!process.env.NODE_ENV) {
    findings.push({
      checkId: 'env.node_env_unset',
      severity: 'warn',
      title: 'NODE_ENV 미설정',
      detail: 'NODE_ENV가 설정되지 않았습니다. production 환경에서는 명시적으로 설정하세요.',
      remediation: 'NODE_ENV=production 으로 설정하세요.',
    });
  }

  const dbPath = process.env.DB_PATH ?? '';
  if (dbPath.startsWith('/tmp') || dbPath.startsWith('/var/tmp')) {
    findings.push({
      checkId: 'env.db_path_tmp',
      severity: 'warn',
      title: 'DB 경로가 임시 디렉토리',
      detail: `DB_PATH(${dbPath})가 임시 디렉토리를 가리킵니다. 재부팅 시 데이터 손실 위험.`,
      remediation: '영구 저장소 경로로 DB_PATH를 변경하세요.',
    });
  }

  const alertInterval = Number(process.env.ALERT_CHECK_INTERVAL_MS);
  if (alertInterval > 0 && alertInterval < 10_000) {
    findings.push({
      checkId: 'env.alert_interval_too_short',
      severity: 'warn',
      title: '알림 체크 간격이 너무 짧음',
      detail: `ALERT_CHECK_INTERVAL_MS(${alertInterval}ms)가 10초 미만입니다. API rate limit에 걸릴 수 있습니다.`,
      remediation: '최소 60000ms (1분) 이상으로 설정하세요.',
    });
  }

  return findings;
}
