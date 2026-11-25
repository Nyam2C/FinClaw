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
      // 서버 반환 {agents} — bare array 아님.
      const result = await deps.callGateway<{ agents?: Record<string, unknown>[] }>('agent.list');
      if (!result.ok) {
        deps.error(theme.error(`Failed to list agents: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      const rows = result.data?.agents ?? [];
      deps.output(rows.length > 0 ? formatTable(rows) : theme.dim('No agents registered.'));
    });

  cmd
    .command('status <name>')
    .description('show agent status')
    .action(async (name: string) => {
      // Phase 37 D(F6): 서버 schema 는 {agentId} strict — {name} 은 INVALID_PARAMS.
      const result = await deps.callGateway<Record<string, unknown>>('agent.status', {
        agentId: name,
      });
      if (!result.ok) {
        deps.error(theme.error(`Failed to get agent status: ${result.error?.message}`));
        deps.exit(EXIT.GATEWAY_ERROR);
        return;
      }
      deps.output(formatKeyValue(result.data ?? {}));
    });
}
