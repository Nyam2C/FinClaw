// packages/server/src/cli/commands/market.ts
import type { Command } from 'commander';
import type { CliDeps } from '../deps.js';
import { EXIT } from '../exit-codes.js';
import { formatKeyValue } from '../terminal/table.js';
import { theme } from '../terminal/theme.js';

export function register(program: Command, deps: CliDeps): void {
  const cmd = program.command('market').description('query market data');

  cmd
    .command('quote <ticker>')
    .description('get a stock quote')
    .option('-f, --format <format>', 'output format (table|json)', 'table')
    .option('-c, --currency <currency>', 'display currency', 'USD')
    .action(async (ticker: string, opts: { format: string; currency: string }) => {
      const result = await deps.callGateway<Record<string, unknown>>('finance.quote', {
        symbol: ticker,
        currency: opts.currency,
      });

      if (!result.ok) {
        deps.error(theme.error(`Failed to get quote: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }

      const data = result.data ?? {};
      if (opts.format === 'json') {
        deps.output(JSON.stringify(data, null, 2));
      } else {
        deps.output(formatKeyValue(data));
      }
    });

  cmd
    .command('watch <ticker>')
    .description('watch a stock price (coming soon)')
    .action((ticker: string) => {
      deps.output(theme.info(`watch ${ticker}: not yet implemented`));
    });
}
