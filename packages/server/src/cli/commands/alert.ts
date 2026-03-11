// packages/server/src/cli/commands/alert.ts
import type { Command } from 'commander';
import type { CliDeps } from '../deps.js';
import { EXIT } from '../exit-codes.js';
import { formatTable } from '../terminal/table.js';
import { theme } from '../terminal/theme.js';

export function register(program: Command, deps: CliDeps): void {
  const cmd = program.command('alert').description('manage alerts');

  cmd
    .command('add')
    .description('add a price alert')
    .requiredOption('-t, --ticker <ticker>', 'stock ticker')
    .requiredOption('-c, --condition <condition>', 'condition (above|below)')
    .requiredOption('-p, --price <price>', 'target price')
    .option('--channel <channel>', 'notification channel')
    .action(
      async (opts: { ticker: string; condition: string; price: string; channel?: string }) => {
        const params: Record<string, unknown> = {
          ticker: opts.ticker,
          condition: opts.condition,
          price: Number(opts.price),
        };
        if (opts.channel) {
          params['channel'] = opts.channel;
        }

        const result = await deps.callGateway('finance.alert.create', params);
        if (!result.ok) {
          deps.error(theme.error(`Failed to create alert: ${result.error?.message}`));
          deps.exit(EXIT.GATEWAY_ERROR);
          return;
        }
        deps.output(theme.success(`Alert created: ${opts.ticker} ${opts.condition} ${opts.price}`));
      },
    );

  cmd
    .command('list')
    .description('list all alerts')
    .action(async () => {
      const result = await deps.callGateway<Record<string, unknown>[]>('finance.alert.list');
      if (!result.ok) {
        deps.error(theme.error(`Failed to list alerts: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      const rows = result.data ?? [];
      deps.output(rows.length > 0 ? formatTable(rows) : theme.dim('No alerts configured.'));
    });

  cmd
    .command('remove <id>')
    .description('remove an alert')
    .action(async (id: string) => {
      const result = await deps.callGateway('finance.alert.remove', { id });
      if (!result.ok) {
        deps.error(theme.error(`Failed to remove alert: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      deps.output(theme.success(`Alert ${id} removed.`));
    });
}
