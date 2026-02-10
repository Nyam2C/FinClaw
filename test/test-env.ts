import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SENSITIVE_KEYS = [
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_ID',
  'CLAUDE_API_KEY',
  'ANTHROPIC_API_KEY',
  'DATABASE_URL',
  'NODE_OPTIONS',
] as const;

interface EnvSnapshot {
  vars: Record<string, string | undefined>;
  tmpDir: string;
}

let snapshot: EnvSnapshot | null = null;

export function isolateEnv(): void {
  if (snapshot) return;

  const vars: Record<string, string | undefined> = {};
  for (const key of SENSITIVE_KEYS) {
    vars[key] = process.env[key];
    delete process.env[key];
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finclaw-test-'));

  process.env.HOME = tmpDir;
  process.env.DB_PATH = path.join(tmpDir, 'test.db');
  process.env.NODE_ENV = 'test';

  snapshot = { vars, tmpDir };
}

export function restoreEnv(): void {
  if (!snapshot) return;

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
