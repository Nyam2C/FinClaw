// packages/server/src/cli/entry.ts
import { createDefaultDeps } from './deps.js';
import { buildProgram } from './program.js';

export async function main(argv: string[] = process.argv): Promise<void> {
  const deps = createDefaultDeps();
  const program = buildProgram(deps);
  await program.parseAsync(argv);
}
