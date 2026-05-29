import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadSubAgents } from './agent-loader.js';

describe('sub-agent loader', () => {
  it('loads frontmatter into id→definition map', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-'));
    writeFileSync(
      join(dir, 'market_analysis.md'),
      `---\nid: market_analysis\nname: MA\nmodel: claude-opus-4-7\nsource: sub-agent\n---\nbody`,
    );
    const map = loadSubAgents(dir);
    expect(map.get('market_analysis')?.model).toBe('claude-opus-4-7');
    expect(map.get('market_analysis')?.source).toBe('sub-agent');
  });

  it('throws when frontmatter id missing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'subagent-'));
    writeFileSync(join(dir, 'bad.md'), `---\nname: x\n---\nbody`);
    expect(() => loadSubAgents(dir)).toThrow();
  });
});
