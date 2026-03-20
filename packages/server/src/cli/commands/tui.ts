// packages/server/src/cli/commands/tui.ts
import type { Command } from 'commander';
import type { CliDeps } from '../deps.js';
import { EXIT } from '../exit-codes.js';
import { theme } from '../terminal/theme.js';

export function register(program: Command, deps: CliDeps): void {
  program
    .command('tui')
    .description('launch the terminal UI control panel')
    .option('-g, --gateway-url <url>', 'gateway server URL', 'ws://127.0.0.1:3000')
    .option('-a, --agent <id>', 'agent ID', 'default')
    .action(async (opts: { gatewayUrl: string; agent: string }) => {
      deps.output(theme.info('Launching TUI...'));

      try {
        const config = await deps.loadConfig();
        const token = config.gateway?.auth?.token ?? '';

        const { runTui } = await import('@finclaw/tui');
        await runTui({
          gatewayUrl: opts.gatewayUrl,
          token,
          agentId: opts.agent,
        });
      } catch (err) {
        deps.error(theme.error(`TUI failed: ${(err as Error).message}`));
        deps.exit(EXIT.ERROR);
      }
    });
}
