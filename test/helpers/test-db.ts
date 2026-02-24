import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface TestDb {
  db: DatabaseSync;
  path: string;
  cleanup: () => void;
}

/**
 * 매 테스트마다 고유한 임시 SQLite DB를 생성한다.
 * afterEach/afterAll에서 cleanup()을 호출하면 DB를 닫고 파일을 삭제한다.
 */
export function createTestDb(): TestDb {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'finclaw-db-'));
  const dbPath = path.join(tmpDir, 'test.db');
  const db = new DatabaseSync(dbPath);

  return {
    db,
    path: dbPath,
    cleanup() {
      try {
        db.close();
      } catch {
        // already closed
      }
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    },
  };
}
