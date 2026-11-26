import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePrompt } from '../prompts/loader.js';

const SUB_AGENTS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../prompts/sub-agents');

export interface SubAgentDefinition {
  readonly id: string;
  readonly name: string;
  readonly model: string;
  readonly source: 'sub-agent' | 'function';
}

/** prompts/sub-agents/*.md frontmatter → id→정의 맵. body 는 메타 설명(미사용). */
export function loadSubAgents(dir: string = SUB_AGENTS_DIR): Map<string, SubAgentDefinition> {
  const map = new Map<string, SubAgentDefinition>();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) {
      continue;
    }
    const { frontmatter } = parsePrompt(readFileSync(join(dir, file), 'utf-8'));
    const id = frontmatter.id;
    if (!id) {
      throw new Error(`sub-agent file ${file} missing frontmatter id`);
    }
    map.set(id, {
      id,
      name: frontmatter.name ?? id,
      model: frontmatter.model ?? 'claude-opus-5-5',
      source: (frontmatter.source as SubAgentDefinition['source']) ?? 'sub-agent',
    });
  }
  return map;
}
