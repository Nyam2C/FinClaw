// packages/server/src/cli/commands/start.ts
import type { Command } from 'commander';
import { spawn } from 'node:child_process';
import type { CliDeps } from '../deps.js';
import { EXIT } from '../exit-codes.js';
import { theme } from '../terminal/theme.js';

export function register(program: Command, deps: CliDeps): void {
  program
    .command('start')
    .description('start the gateway server')
    .option('-p, --port <port>', 'server port', '3000')
    .option('-H, --host <host>', 'server host', '127.0.0.1')
    .option('-d, --detach', 'run in background')
    .action(async (opts: { port: string; host: string; detach?: boolean }) => {
      if (opts.detach) {
        deps.output(theme.info(`Starting gateway in background on ${opts.host}:${opts.port}...`));

        const child = spawn(
          process.execPath,
          [process.argv[1] ?? '', 'start', '--port', opts.port, '--host', opts.host],
          {
            detached: true,
            stdio: 'ignore',
            env: { ...process.env, FINCLAW_PORT: opts.port, FINCLAW_HOST: opts.host },
          },
        );

        child.unref();
        deps.output(theme.success(`Gateway started (pid: ${String(child.pid)})`));
        return;
      }

      deps.output(theme.info(`Starting gateway on ${opts.host}:${opts.port}...`));

      try {
        process.env['FINCLAW_PORT'] = opts.port;
        process.env['FINCLAW_HOST'] = opts.host;
        await import('../../main.js');
      } catch (err) {
        deps.error(theme.error(`Failed to start: ${(err as Error).message}`));
        deps.exit(EXIT.ERROR);
      }
    });
}
