import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_PATH = resolve(HERE, '../../../package.json');

describe('@finclaw/server package.json#files', () => {
  it('contains prompts/**/*.md so .md files ship with the package', async () => {
    const pkg = JSON.parse(await readFile(PKG_PATH, 'utf-8')) as { files?: readonly string[] };
    expect(pkg.files ?? []).toContain('prompts/**/*.md');
  });
});
