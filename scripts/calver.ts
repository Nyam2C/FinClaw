#!/usr/bin/env tsx
/**
 * CalVer 버전 자동 생성
 *
 * YYYY.M.D 형식 (예: 2026.3.22)
 * 같은 날 복수 릴리즈 시 suffix 추가 (예: 2026.3.22.1)
 *
 * 사용법:
 *   tsx scripts/calver.ts          # 버전 태그명 출력만
 *   tsx scripts/calver.ts --tag    # git tag -a 생성
 */
import { execFileSync, execSync } from 'node:child_process';

function exec(cmd: string): string {
  try {
    return execSync(cmd, { encoding: 'utf-8' }).trim();
  } catch {
    return '';
  }
}

function generateCalVer(): string {
  const now = new Date();
  const base = `${now.getFullYear()}.${now.getMonth() + 1}.${now.getDate()}`;

  // 같은 날 기존 태그 확인
  const existingTags = exec(`git tag -l "v${base}*"`).split('\n').filter(Boolean);

  if (existingTags.length === 0) {
    return base;
  }

  // suffix 계산: v2026.3.22 → v2026.3.22.1 → v2026.3.22.2
  let maxSuffix = 0;
  for (const tag of existingTags) {
    const parts = tag.replace('v', '').split('.');
    if (parts.length === 4) {
      const suffix = parseInt(parts[3] ?? '0', 10);
      if (suffix > maxSuffix) {
        maxSuffix = suffix;
      }
    }
  }

  return `${base}.${maxSuffix + 1}`;
}

const version = generateCalVer();
const tagName = `v${version}`;

console.log(tagName);

if (process.argv.includes('--tag')) {
  execFileSync('git', ['tag', '-a', tagName, '-m', `Release ${version}`], { stdio: 'inherit' });
  console.log(`Tag ${tagName} created.`);
}
