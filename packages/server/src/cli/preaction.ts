// packages/server/src/cli/preaction.ts
import type { Command } from 'commander';
import type { CliDeps } from './deps.js';
import { EXIT } from './exit-codes.js';
import { theme } from './terminal/theme.js';

/**
 * Commander pre-action 훅 등록.
 * - 배너 출력 (verbose 모드)
 * - 설정 파일 검증
 */
export function registerPreActionHooks(program: Command, deps: CliDeps): void {
  program.hook('preAction', (_thisCmd, actionCmd) => {
    const opts = actionCmd.optsWithGlobals<{ verbose?: boolean }>();

    // verbose 배너
    if (opts.verbose) {
      deps.output(theme.dim(`finclaw v${program.version()}`));
    }

    // 설정 검증 (start 등 서버 명령에만 필요하지만 일단 공통)
    try {
      deps.loadConfig();
    } catch (err) {
      deps.error(theme.error(`Config error: ${(err as Error).message}`));
      deps.exit(EXIT.CONFIG_ERROR);
    }
  });
}
