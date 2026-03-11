// packages/server/src/cli/commands/agent.ts
import type { Command } from 'commander';
import type { CliDeps } from '../deps.js';
import { EXIT } from '../exit-codes.js';
import { formatTable, formatKeyValue } from '../terminal/table.js';
import { theme } from '../terminal/theme.js';

export function register(program: Command, deps: CliDeps): void {
  const cmd = program.command('agent').description('manage agents');

  cmd
    .command('list')
    .description('list all agents')
    .action(async () => {
      const result = await deps.callGateway<Record<string, unknown>[]>('agent.list');
      if (!result.ok) {
        deps.error(theme.error(`Failed to list agents: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      const rows = result.data ?? [];
      deps.output(rows.length > 0 ? formatTable(rows) : theme.dim('No agents registered.'));
    });

  cmd
    .command('status <name>')
    .description('show agent status')
    .action(async (name: string) => {
      const result = await deps.callGateway<Record<string, unknown>>('agent.status', { name });
      if (!result.ok) {
        deps.error(theme.error(`Failed to get agent status: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      deps.output(formatKeyValue(result.data ?? {}));
    });
}
