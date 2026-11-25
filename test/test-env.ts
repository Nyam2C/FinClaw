import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 런타임이 읽는 비밀값·경로 env (packages/*/src 의 process.env / readKeyArray 기준).
const SENSITIVE_KEYS = [
  'DISCORD_BOT_TOKEN',
  'ANTHROPIC_API_KEY',
  'GATEWAY_JWT_SECRET',
  'FINCLAW_API_KEY',
  'FINCLAW_DB_PATH',
  'FINCLAW_CONFIG',
  'FINCLAW_PLUGINS_DIR',
  'VOYAGE_API_KEY',
  'OPENAI_API_KEY',
  'FINNHUB_KEY',
  'TWELVE_DATA_KEY',
  'ALPHA_VANTAGE_KEY',
  'COINGECKO_API_KEY',
  'NEWSDATA_API_KEY',
  'KIS_APP_KEY',
  'KIS_APP_SECRET',
  'KIS_ACCOUNT_NO',
  'NODE_OPTIONS',
] as const;

interface EnvSnapshot {
  vars: Record<string, string | undefined>;
  tmpDir: string;
}

let snapshot: EnvSnapshot | null = null;

export function isolateEnv(): void {
  if (snapshot) {
    return;
  }

  const vars: Record<string, string | undefined> = {};
  // readKeyArray 의 인덱스 형식(FINNHUB_KEY_1 …)도 함께 격리.
  const keys = Object.keys(process.env).filter((k) =>
    SENSITIVE_KEYS.some((s) => k === s || k.startsWith(`${s}_`)),
  );
  for (const key of new Set([...SENSITIVE_KEYS, ...keys])) {
    vars[key] = process.env[key];
    delete process.env[key];
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finclaw-test-'));

  process.env.HOME = tmpDir;
  process.env.FINCLAW_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.NODE_ENV = 'test';

  snapshot = { vars, tmpDir };
}

export function restoreEnv(): void {
  if (!snapshot) {
    return;
  }

  for (const [key, value] of Object.entries(snapshot.vars)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    fs.rmSync(snapshot.tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }

  snapshot = null;
}
