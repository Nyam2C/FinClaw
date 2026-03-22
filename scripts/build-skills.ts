#!/usr/bin/env tsx
/**
 * 금융 스킬 번들링 스크립트
 *
 * packages/skills-finance/dist/ 의 빌드 결과를 스킬별 독립 번들로 패키징.
 * 각 스킬을 개별적으로 배포/설치할 수 있게 한다.
 *
 * 사전 조건: pnpm build 완료 (tsc --build로 dist/ 생성)
 *
 * 사용법:
 *   tsx scripts/build-skills.ts                  # 전체 빌드
 *   tsx scripts/build-skills.ts --skill=market   # market만
 *   tsx scripts/build-skills.ts --outdir=out     # 출력 디렉토리 변경
 */
import { readdirSync, existsSync, mkdirSync, cpSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const SKILLS_DIST_DIR = resolve('packages/skills-finance/dist');
const DEFAULT_OUT_DIR = resolve('dist/skills');

// TODO: 스킬 수가 늘어나면 readdirSync로 자동 탐색 전환 고려
const SKILL_DIRS = ['market', 'news', 'alerts'] as const;

interface SkillBuildResult {
  name: string;
  files: number;
  success: boolean;
  error?: string;
}

function countFiles(dir: string): number {
  try {
    return readdirSync(dir, { recursive: true, withFileTypes: true }).filter((d) => d.isFile())
      .length;
  } catch {
    return 0;
  }
}

function buildSkills(options: { skillFilter?: string; outDir?: string }): void {
  const outDir = options.outDir ?? DEFAULT_OUT_DIR;

  if (!existsSync(SKILLS_DIST_DIR)) {
    console.error(`Error: ${SKILLS_DIST_DIR} does not exist. Run 'pnpm build' first.`);
    process.exit(1);
  }

  mkdirSync(outDir, { recursive: true });

  const targets = SKILL_DIRS.filter((d) => !options.skillFilter || d === options.skillFilter);

  if (targets.length === 0) {
    console.error(`No matching skill: ${options.skillFilter}`);
    process.exit(1);
  }

  console.log(`Building ${targets.length} skill(s)...`);

  const results: SkillBuildResult[] = [];

  for (const name of targets) {
    const srcDir = join(SKILLS_DIST_DIR, name);
    const destDir = join(outDir, name);

    try {
      if (!existsSync(srcDir)) {
        throw new Error(`Compiled output not found: ${srcDir}`);
      }

      mkdirSync(destDir, { recursive: true });
      cpSync(srcDir, destDir, { recursive: true });

      // 스킬 메타데이터 생성
      const meta = {
        name,
        builtAt: new Date().toISOString(),
        source: '@finclaw/skills-finance',
      };
      writeFileSync(join(destDir, 'skill.meta.json'), JSON.stringify(meta, null, 2) + '\n');

      const fileCount = countFiles(destDir);
      results.push({ name, files: fileCount, success: true });
      console.log(`  [OK] ${name} (${fileCount} files)`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      results.push({ name, files: 0, success: false, error: msg });
      console.error(`  [FAIL] ${name}: ${msg}`);
    }
  }

  const succeeded = results.filter((r) => r.success).length;
  const failed = results.filter((r) => !r.success).length;
  console.log(`\nBuild complete: ${succeeded} succeeded, ${failed} failed`);

  if (failed > 0) {
    process.exit(1);
  }
}

// CLI 파싱
const args = process.argv.slice(2);
const skillFilter = args.find((a) => a.startsWith('--skill='))?.split('=')[1];
const outDir = args.find((a) => a.startsWith('--outdir='))?.split('=')[1];

buildSkills({ skillFilter, outDir });
