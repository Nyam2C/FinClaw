// packages/server/src/cli/preaction.ts
import type { Command } from 'commander';
import type { CliDeps } from './deps.js';
import { EXIT } from './exit-codes.js';
import { theme } from './terminal/theme.js';

/** 설정 검증을 스킵하는 명령어 */
const SKIP_CONFIG_COMMANDS = new Set(['start', 'config', 'health', 'status']);

/**
 * Commander pre-action 훅 등록.
 * - 배너 출력 (verbose 모드, --json 미사용 시)
 * - 설정 파일 검증 (화이트리스트 외 명령어)
 */
export function registerPreActionHooks(program: Command, deps: CliDeps): void {
  program.hook('preAction', async (_thisCmd, actionCmd) => {
    const opts = actionCmd.optsWithGlobals<{ verbose?: boolean; json?: boolean }>();

    // verbose 배너 (--json 모드에서는 미출력)
    if (opts.verbose && !opts.json) {
      deps.output(theme.dim(`finclaw v${program.version()}`));
    }

    // 명령어 이름 결정 (서브커맨드면 부모 이름 사용)
    const cmdName =
      actionCmd.parent?.name() !== program.name()
        ? (actionCmd.parent?.name() ?? actionCmd.name())
        : actionCmd.name();

    // 화이트리스트 명령어는 설정 검증 스킵
    if (SKIP_CONFIG_COMMANDS.has(cmdName)) {
      return;
    }

    try {
      await deps.loadConfig();
    } catch (err) {
      deps.error(theme.error(`Config error: ${(err as Error).message}`));
      deps.exit(EXIT.CONFIG_ERROR);
    }
  });
}
