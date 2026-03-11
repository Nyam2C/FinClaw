// packages/server/src/cli/commands/config.ts
import type { Command } from 'commander';
import type { CliDeps } from '../deps.js';
import { EXIT } from '../exit-codes.js';
import { formatKeyValue } from '../terminal/table.js';
import { theme } from '../terminal/theme.js';

export function register(program: Command, deps: CliDeps): void {
  const cmd = program.command('config').description('manage configuration');

  cmd
    .command('list')
    .description('list all configuration values')
    .action(async () => {
      const result = await deps.callGateway<Record<string, unknown>>('config.get');
      if (!result.ok) {
        deps.error(theme.error(`Failed to get config: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      deps.output(formatKeyValue(result.data ?? {}));
    });

  cmd
    .command('get <key>')
    .description('get a configuration value')
    .action(async (key: string) => {
      const result = await deps.callGateway<Record<string, unknown>>('config.get', { key });
      if (!result.ok) {
        deps.error(theme.error(`Failed to get config: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      deps.output(formatKeyValue(result.data ?? {}));
    });

  cmd
    .command('set <key> <value>')
    .description('set a configuration value')
    .action(async (key: string, value: string) => {
      const result = await deps.callGateway('config.update', { key, value });
      if (!result.ok) {
        deps.error(theme.error(`Failed to set config: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      deps.output(theme.success(`Set ${key} = ${value}`));
    });
}
