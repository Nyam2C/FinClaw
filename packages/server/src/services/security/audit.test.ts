// packages/server/src/services/security/audit.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { runSecurityAudit } from './audit.js';

describe('runSecurityAudit', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('필수 API 키 미설정 시 critical finding을 생성한다', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.DISCORD_TOKEN;

    const report = await runSecurityAudit({ checkFilePermissions: false });

    const criticals = report.findings.filter((f) => f.severity === 'critical');
    expect(criticals.length).toBeGreaterThanOrEqual(2);
    expect(report.summary.critical).toBeGreaterThanOrEqual(2);
  });

  it('선택 API 키 미설정 시 info finding을 생성한다', async () => {
    delete process.env.ALPHA_VANTAGE_API_KEY;
    delete process.env.COINGECKO_API_KEY;

    const report = await runSecurityAudit({ checkFilePermissions: false });

    const infos = report.findings.filter((f) => f.severity === 'info');
    expect(infos.some((f) => f.checkId.includes('alpha_vantage'))).toBe(true);
  });

  it('위험한 환경변수 감지 시 warn finding을 생성한다', async () => {
    process.env.LD_PRELOAD = '/some/lib.so';

    const report = await runSecurityAudit({ checkFilePermissions: false });

    const warns = report.findings.filter((f) => f.checkId.includes('ld_preload'));
    expect(warns).toHaveLength(1);
    expect(warns[0].severity).toBe('warn');
  });

  it('NODE_ENV 미설정 시 warn finding을 생성한다', async () => {
    delete process.env.NODE_ENV;

    const report = await runSecurityAudit({ checkFilePermissions: false, checkApiKeys: false });

    expect(report.findings.some((f) => f.checkId === 'env.node_env_unset')).toBe(true);
  });

  it('DB_PATH가 /tmp일 때 warn finding을 생성한다', async () => {
    process.env.DB_PATH = '/tmp/finclaw.db';

    const report = await runSecurityAudit({ checkFilePermissions: false, checkApiKeys: false });

    expect(report.findings.some((f) => f.checkId === 'env.db_path_tmp')).toBe(true);
  });

  it('ALERT_CHECK_INTERVAL_MS가 10초 미만일 때 warn finding을 생성한다', async () => {
    process.env.ALERT_CHECK_INTERVAL_MS = '5000';

    const report = await runSecurityAudit({ checkFilePermissions: false, checkApiKeys: false });

    expect(report.findings.some((f) => f.checkId === 'env.alert_interval_too_short')).toBe(true);
  });

  it('WSL 환경에서 파일 퍼미션 검사를 건너뛴다', async () => {
    process.env.WSL_DISTRO_NAME = 'Ubuntu';

    const report = await runSecurityAudit({ checkApiKeys: false, checkEnvironment: false });

    expect(report.findings.some((f) => f.checkId === 'file_perm.skipped')).toBe(true);
  });

  it('summary가 severity별 카운트를 정확히 집계한다', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.NODE_ENV;

    const report = await runSecurityAudit({ checkFilePermissions: false });

    expect(report.summary.critical + report.summary.warn + report.summary.info).toBe(
      report.findings.length,
    );
  });

  it('timestamp가 리포트에 포함된다', async () => {
    const before = Date.now();
    const report = await runSecurityAudit({
      checkApiKeys: false,
      checkFilePermissions: false,
      checkEnvironment: false,
    });
    const after = Date.now();

    expect(report.timestamp).toBeGreaterThanOrEqual(before);
    expect(report.timestamp).toBeLessThanOrEqual(after);
  });
});
