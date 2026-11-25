import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../prompts/news');

export class SkillPromptLoadError extends Error {
  constructor(
    message: string,
    public readonly searchDir: string,
    public readonly filename: string,
  ) {
    super(message);
    this.name = 'SkillPromptLoadError';
  }
}

async function readPromptFile(filename: string, callerHint: string): Promise<string> {
  const fullPath = resolve(PROMPTS_DIR, filename);
  try {
    return (await readFile(fullPath, 'utf-8')).trim();
  } catch {
    throw new SkillPromptLoadError(
      `Skill prompt file not found: ${filename}\n  searched in: ${PROMPTS_DIR}\n  required by: ${callerHint}`,
      PROMPTS_DIR,
      filename,
    );
  }
}

/** route_task market_analysis 는 standard 깊이·한국어로 고정 — 프롬프트 1종만 유지. */
export async function loadAnalysisPrompt(): Promise<string> {
  return readPromptFile('analyze.standard.ko.md', 'loadAnalysisPrompt()');
}
