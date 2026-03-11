// packages/server/src/cli/route.ts
import type { CliDeps } from './deps.js';
import { EXIT } from './exit-codes.js';
import { formatKeyValue } from './terminal/table.js';
import { theme } from './terminal/theme.js';

export interface RouteSpec {
  readonly command: string;
  handle(deps: CliDeps): Promise<number>;
}

const routes: readonly RouteSpec[] = [
  {
    command: 'health',
    async handle(deps) {
      const result = await deps.getGatewayHealth();
      if (!result.ok) {
        deps.error(theme.error(`Gateway health check failed: ${result.error?.message}`));
        return EXIT.GATEWAY_ERROR;
      }
      deps.output(formatKeyValue(result.data as Record<string, unknown>));
      return EXIT.OK;
    },
  },
  {
    command: 'status',
    async handle(deps) {
      const result = await deps.callGateway('system.info');
      if (!result.ok) {
        deps.error(theme.error(`Failed to get system info: ${result.error?.message}`));
        return EXIT.GATEWAY_ERROR;
      }
      deps.output(formatKeyValue(result.data as Record<string, unknown>));
      return EXIT.OK;
    },
  },
];

/**
 * argv에서 fast-path 명령을 찾아 실행.
 * 매칭되면 종료 코드를 반환, 아니면 null.
 */
export async function tryFastPath(argv: readonly string[], deps: CliDeps): Promise<number | null> {
  // 옵션 제외한 첫 positional arg
  const cmd = argv.find((arg) => !arg.startsWith('-'));
  if (!cmd) {
    return null;
  }

  const route = routes.find((r) => r.command === cmd);
  if (!route) {
    return null;
  }

  return route.handle(deps);
}
