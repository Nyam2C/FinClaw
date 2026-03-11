import { Command } from 'commander';
// packages/server/src/cli/program.ts
import { readFileSync } from 'node:fs';
import type { CliDeps } from './deps.js';
import * as agentCmd from './commands/agent.js';
import * as alertCmd from './commands/alert.js';
import * as channelCmd from './commands/channel.js';
import * as configCmd from './commands/config.js';
import * as marketCmd from './commands/market.js';
import * as newsCmd from './commands/news.js';
import * as startCmd from './commands/start.js';
import * as stopCmd from './commands/stop.js';
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
    .option('--gateway-url <url>', 'gateway server URL', 'http://127.0.0.1:3000')
    .option('--json', 'output as JSON')
    .option('--no-color', 'disable color output');

  registerPreActionHooks(program, deps);

  // ── Commands ──
  startCmd.register(program, deps);
  stopCmd.register(program, deps);
  configCmd.register(program, deps);
  agentCmd.register(program, deps);
  channelCmd.register(program, deps);
  marketCmd.register(program, deps);
  newsCmd.register(program, deps);
  alertCmd.register(program, deps);

  // TODO: health/status를 commands/로 추출하면 일관성 향상
  program
    .command('health')
    .description('check gateway health')
    .action(async () => {
      const result = await deps.getGatewayHealth();
      if (!result.ok) {
        deps.error(theme.error(`Gateway unreachable: ${result.error?.message}`));
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
        deps.error(theme.error(`Failed to get status: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      const { formatKeyValue } = await import('./terminal/table.js');
      deps.output(formatKeyValue(result.data as Record<string, unknown>));
    });

  return program;
}
