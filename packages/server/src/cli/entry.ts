// packages/server/src/cli/entry.ts
import { createDefaultDeps } from './deps.js';
import { buildProgram } from './program.js';
import { tryFastPath } from './route.js';

export async function main(argv: string[] = process.argv): Promise<void> {
  const deps = createDefaultDeps();

  // fast-path: health, status 등 Commander 없이 직접 처리
  const userArgs = argv.slice(2);
  const fastResult = await tryFastPath(userArgs, deps);
  if (fastResult !== null) {
    deps.exit(fastResult);
    return;
  }

  // Commander 기반 라우팅
  const program = buildProgram(deps);
  await program.parseAsync(argv);
}
