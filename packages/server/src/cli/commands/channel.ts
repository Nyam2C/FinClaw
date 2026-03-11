// packages/server/src/cli/commands/channel.ts
import type { Command } from 'commander';
import type { CliDeps } from '../deps.js';
import { EXIT } from '../exit-codes.js';
import { formatTable, formatKeyValue } from '../terminal/table.js';
import { theme } from '../terminal/theme.js';

export function register(program: Command, deps: CliDeps): void {
  const cmd = program.command('channel').description('manage channels');

  cmd
    .command('list')
    .description('list all channels')
    .action(async () => {
      const result = await deps.callGateway<Record<string, unknown>[]>('channel.list');
      if (!result.ok) {
        deps.error(theme.error(`Failed to list channels: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      const rows = result.data ?? [];
      deps.output(rows.length > 0 ? formatTable(rows) : theme.dim('No channels registered.'));
    });

  cmd
    .command('status <name>')
    .description('show channel status')
    .action(async (name: string) => {
      const result = await deps.callGateway<Record<string, unknown>>('channel.status', { name });
      if (!result.ok) {
        deps.error(theme.error(`Failed to get channel status: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      deps.output(formatKeyValue(result.data ?? {}));
    });
}
