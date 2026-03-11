// packages/server/src/cli/index.ts — barrel export

export { EXIT } from './exit-codes.js';
export type { ExitCode } from './exit-codes.js';

export { theme } from './terminal/theme.js';
export { formatTable, formatKeyValue } from './terminal/table.js';

export type { RpcResult, GatewayClientOptions } from './gateway-client.js';
export { getGatewayHealth, callGateway } from './gateway-client.js';

export type { CliDeps } from './deps.js';
export { createDefaultDeps } from './deps.js';

export { tryFastPath } from './route.js';
export { buildProgram, createProgramContext } from './program.js';
export { registerPreActionHooks } from './preaction.js';
export { main } from './entry.js';
