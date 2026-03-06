import { Command } from 'commander';
// packages/server/src/cli/program.ts
import { readFileSync } from 'node:fs';
import type { CliDeps } from './deps.js';
import { EXIT } from './exit-codes.js';
import { registerPreActionHooks } from './preaction.js';
import { theme } from './terminal/theme.js';

/** package.json에서 버전 읽기 */
export function createProgramContext(): { version: string } {
  const pkgPath = new URL('../../package.json', import.meta.url);
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };
  return { version: pkg.version };
}

/** Commander 프로그램 구성 */
export function buildProgram(deps: CliDeps): Command {
  const ctx = createProgramContext();

  const program = new Command()
    .name('finclaw')
    .version(ctx.version)
    .description('FinClaw — AI-powered financial assistant CLI')
    .option('-v, --verbose', 'enable verbose output')
    .option('--gateway-url <url>', 'gateway server URL', 'http://127.0.0.1:3000');

  registerPreActionHooks(program, deps);

  // ── Placeholder commands ──

  program
    .command('start')
    .description('start the gateway server')
    .action(() => {
      deps.output(theme.info('start: not yet implemented'));
    });

  program
    .command('stop')
    .description('stop the gateway server')
    .action(() => {
      deps.output(theme.info('stop: not yet implemented'));
    });

  program
    .command('config')
    .description('manage configuration')
    .action(() => {
      deps.output(theme.info('config: not yet implemented'));
    });

  program
    .command('agent')
    .description('manage agents')
    .action(() => {
      deps.output(theme.info('agent: not yet implemented'));
    });

  program
    .command('channel')
    .description('manage channels')
    .action(() => {
      deps.output(theme.info('channel: not yet implemented'));
    });

  program
    .command('market')
    .description('query market data')
    .action(() => {
      deps.output(theme.info('market: not yet implemented'));
    });

  program
    .command('news')
    .description('query financial news')
    .action(() => {
      deps.output(theme.info('news: not yet implemented'));
    });

  program
    .command('alert')
    .description('manage alerts')
    .action(() => {
      deps.output(theme.info('alert: not yet implemented'));
    });

  program
    .command('health')
    .description('check gateway health')
    .action(async () => {
      const result = await deps.getGatewayHealth();
      if (!result.ok) {
        deps.error(theme.error(`Gateway unreachable: ${result.error}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      const { formatKeyValue } = await import('./terminal/table.js');
      deps.output(formatKeyValue(result.data as Record<string, unknown>));
    });

  program
    .command('status')
    .description('show system status')
    .action(async () => {
      const result = await deps.callGateway('system.info');
      if (!result.ok) {
        deps.error(theme.error(`Failed to get status: ${result.error}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      const { formatKeyValue } = await import('./terminal/table.js');
      deps.output(formatKeyValue(result.data as Record<string, unknown>));
    });

  return program;
}
