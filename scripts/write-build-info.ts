#!/usr/bin/env tsx
/**
 * 빌드 메타데이터 생성
 *
 * git describe + git rev-parse로 버전/SHA를 추출하여
 * packages/server/build-info.json에 기록한다.
 *
 * 사용법: tsx scripts/write-build-info.ts
 * CI에서: release.yml의 빌드 단계에서 실행
 */
import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// TODO: calver.ts와 동일한 exec() 헬퍼 — 스크립트 증가 시 공유 유틸 추출 고려
function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

const version = exec('git describe --tags --always') || '0.0.0-dev';
const gitSha = exec('git rev-parse --short HEAD') || 'unknown';
const builtAt = new Date().toISOString();

const buildInfo = { version, gitSha, builtAt };

const outPath = resolve('packages/server/build-info.json');
writeFileSync(outPath, JSON.stringify(buildInfo, null, 2) + '\n');

console.log(`build-info.json written to ${outPath}`);
console.log(JSON.stringify(buildInfo, null, 2));
