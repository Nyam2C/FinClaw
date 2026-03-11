// packages/server/src/cli/commands/stop.ts
import type { Command } from 'commander';
import type { CliDeps } from '../deps.js';
import { EXIT } from '../exit-codes.js';
import { theme } from '../terminal/theme.js';

// TODO: 에러 처리 패턴이 안정화되면 공통 헬퍼로 추출 가능
export function register(program: Command, deps: CliDeps): void {
  program
    .command('stop')
    .description('stop the gateway server')
    .action(async () => {
      const result = await deps.callGateway('system.shutdown');
      if (!result.ok) {
        deps.error(theme.error(`Failed to stop gateway: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      deps.output(theme.success('Gateway stopped successfully.'));
    });
}
