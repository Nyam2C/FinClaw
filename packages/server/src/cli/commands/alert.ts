// packages/server/src/cli/commands/alert.ts
import type { Command } from 'commander';
import type { CliDeps } from '../deps.js';
import { EXIT } from '../exit-codes.js';
import { formatTable } from '../terminal/table.js';
import { theme } from '../terminal/theme.js';

/** CLI `above|below` → 서버 finance.alert.create enum. 그 외 값은 그대로 보내 서버 검증에 맡긴다. */
const CONDITIONS: Readonly<Record<string, string>> = { above: 'price_above', below: 'price_below' };

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
        // 서버 schema {symbol, condition: price_above|price_below|…, threshold} 로 매핑 (CLI 인자는 above|below 유지)
        const params: Record<string, unknown> = {
          symbol: opts.ticker,
          condition: CONDITIONS[opts.condition] ?? opts.condition,
          threshold: Number(opts.price),
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
      // Phase 37 D(F7): 서버 반환 {alerts,total} — bare array 아님.
      const result = await deps.callGateway<{ alerts?: Record<string, unknown>[]; total?: number }>(
        'finance.alert.list',
      );
      if (!result.ok) {
        deps.error(theme.error(`Failed to list alerts: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      const rows = result.data?.alerts ?? [];
      deps.output(rows.length > 0 ? formatTable(rows) : theme.dim('No alerts configured.'));
    });
}
