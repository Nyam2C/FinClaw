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

export type AnalysisDepth = 'brief' | 'standard' | 'detailed';
export type AnalysisLanguage = 'ko' | 'en';

export async function loadAnalysisPrompt(
  depth: AnalysisDepth,
  language: AnalysisLanguage,
): Promise<string> {
  return readPromptFile(
    `analyze.${depth}.${language}.md`,
    `loadAnalysisPrompt(${depth},${language})`,
  );
}

export async function loadSentimentPrompt(ruleHint: number): Promise<string> {
  const tpl = await readPromptFile('sentiment.system.md', 'loadSentimentPrompt');
  return tpl.replaceAll('{{ruleHint}}', ruleHint.toFixed(2));
}
