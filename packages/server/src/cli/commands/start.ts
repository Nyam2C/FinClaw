import { spawn } from 'node:child_process';
// packages/server/src/cli/commands/start.ts
import type { Command } from 'commander';
import type { CliDeps } from '../deps.js';
import { EXIT } from '../exit-codes.js';
import { theme } from '../terminal/theme.js';

export function register(program: Command, deps: CliDeps): void {
  program
    .command('start')
    .description('start the gateway server')
    .option('-d, --detach', 'run in background')
    .action(async (opts: { detach?: boolean }) => {
      if (opts.detach) {
        deps.output(theme.info('Starting gateway in background...'));

        const child = spawn(process.execPath, [process.argv[1] ?? '', 'start'], {
          detached: true,
          stdio: 'ignore',
        });

        child.unref();
        deps.output(theme.success(`Gateway started (pid: ${String(child.pid)})`));
        return;
      }

      deps.output(theme.info('Starting gateway...'));

      try {
        await import('../../main.js');
      } catch (err) {
        deps.error(theme.error(`Failed to start: ${(err as Error).message}`));
        deps.exit(EXIT.ERROR);
      }
    });
}
