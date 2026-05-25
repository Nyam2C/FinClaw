// packages/server/src/cli/commands/news.ts
import type { Command } from 'commander';
import type { CliDeps } from '../deps.js';
import { EXIT } from '../exit-codes.js';
import { formatTable } from '../terminal/table.js';
import { theme } from '../terminal/theme.js';

export function register(program: Command, deps: CliDeps): void {
  program
    .command('news [query]')
    .description('query financial news')
    .option('-s, --symbols <symbols>', 'filter by symbols (comma-separated)')
    .option('-f, --format <format>', 'output format (table|json)', 'table')
    .action(async (query: string | undefined, opts: { symbols?: string; format: string }) => {
      const params: Record<string, unknown> = {};
      if (query) {
        params['query'] = query;
      }
      if (opts.symbols) {
        params['symbols'] = opts.symbols.split(',');
      }

      // Phase 37 D(F8): 서버 반환 {articles,total} — bare array 아님.
      const result = await deps.callGateway<{
        articles?: Record<string, unknown>[];
        total?: number;
      }>('finance.news', params);

      if (!result.ok) {
        deps.error(theme.error(`Failed to get news: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }

      const rows = result.data?.articles ?? [];
      if (rows.length === 0) {
        deps.output(theme.dim('No news found.'));
        return;
      }

      if (opts.format === 'json') {
        deps.output(JSON.stringify(rows, null, 2));
      } else {
        deps.output(formatTable(rows));
      }
    });
}
