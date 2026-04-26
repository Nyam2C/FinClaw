import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROMPTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts');

export interface PromptDocument {
  readonly frontmatter: Readonly<Record<string, string>>;
  readonly body: string;
}

export class PromptLoadError extends Error {
  constructor(
    message: string,
    public readonly searchDir: string,
    public readonly filename: string,
    public readonly missingKey?: string,
  ) {
    super(message);
    this.name = 'PromptLoadError';
  }
}

export async function loadPrompt(filename: string, callerHint?: string): Promise<PromptDocument> {
  const fullPath = resolve(PROMPTS_DIR, filename);
  let raw: string;
  try {
    raw = await readFile(fullPath, 'utf-8');
  } catch {
    throw new PromptLoadError(
      `Prompt file not found: ${filename}\n  searched in: ${PROMPTS_DIR}\n  required by: ${callerHint ?? '<unknown>'}`,
      PROMPTS_DIR,
      filename,
    );
  }
  return parsePrompt(raw);
}

export function parsePrompt(raw: string): PromptDocument {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: raw.trim() };
  }
  const frontmatter: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      continue;
    }
    const colon = trimmed.indexOf(':');
    if (colon === -1) {
      continue;
    }
    const key = trimmed.slice(0, colon).trim();
    const value = trimmed.slice(colon + 1).trim();
    frontmatter[key] = value;
  }
  return { frontmatter, body: match[2].trim() };
}

export function requireFrontmatterKeys(
  doc: PromptDocument,
  filename: string,
  keys: readonly string[],
  callerHint?: string,
): void {
  for (const key of keys) {
    if (!(key in doc.frontmatter)) {
      throw new PromptLoadError(
        `Missing frontmatter key '${key}' in ${filename}\n  searched in: ${PROMPTS_DIR}\n  required by: ${callerHint ?? '<unknown>'}`,
        PROMPTS_DIR,
        filename,
        key,
      );
    }
  }
}
