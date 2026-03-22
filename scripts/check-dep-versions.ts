#!/usr/bin/env tsx
/**
 * 워크스페이스 의존성 버전 일치 검증
 *
 * 모든 패키지에서 공통 의존성(zod, typescript 등)의 버전이 일치하는지 확인.
 * 불일치 발견 시 exit 1.
 *
 * 사용법: tsx scripts/check-dep-versions.ts
 * CI에서: ci.yml 또는 release.yml에 추가 가능
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const PACKAGES_DIR = 'packages';

interface PkgJson {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

// 모든 패키지의 package.json 수집
const pkgDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());

const depMap = new Map<string, Array<{ pkg: string; version: string }>>();

for (const dir of pkgDirs) {
  const pkgPath = join(PACKAGES_DIR, dir.name, 'package.json');
  let pkg: PkgJson;
  try {
    pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as PkgJson;
  } catch {
    continue;
  }

  const allDeps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const [dep, ver] of Object.entries(allDeps)) {
    if (ver.startsWith('workspace:')) {
      continue;
    }
    if (!depMap.has(dep)) {
      depMap.set(dep, []);
    }
    depMap.get(dep)?.push({ pkg: pkg.name, version: ver });
  }
}

// 불일치 검출
let hasConflict = false;

for (const [dep, entries] of depMap) {
  const versions = new Set(entries.map((e) => e.version));
  if (versions.size > 1) {
    hasConflict = true;
    console.error(`[CONFLICT] ${dep}:`);
    for (const entry of entries) {
      console.error(`  ${entry.pkg}: ${entry.version}`);
    }
  }
}

if (hasConflict) {
  console.error('\nDependency version conflicts detected.');
  process.exit(1);
} else {
  console.log('All dependency versions are consistent.');
}
