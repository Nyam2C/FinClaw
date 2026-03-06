import type { FinClawLogger } from '@finclaw/infra';
// packages/server/src/cli/deps.ts
import type { FinClawConfig } from '@finclaw/types';
import { loadConfig as loadConfigImpl } from '@finclaw/config';
import { createLogger } from '@finclaw/infra';
import type { RpcResult, GatewayClientOptions } from './gateway-client.js';
import {
  callGateway as callGatewayImpl,
  getGatewayHealth as getGatewayHealthImpl,
} from './gateway-client.js';

export interface CliDeps {
  loadConfig(): FinClawConfig;
  log: FinClawLogger;
  callGateway<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    opts?: GatewayClientOptions,
  ): Promise<RpcResult<T>>;
  getGatewayHealth(opts?: GatewayClientOptions): Promise<RpcResult<Record<string, unknown>>>;
  exit(code: number): void;
  output(msg: string): void;
  error(msg: string): void;
}

export function createDefaultDeps(overrides?: Partial<CliDeps>): CliDeps {
  const log = createLogger({ name: 'cli' });

  const defaults: CliDeps = {
    loadConfig: loadConfigImpl,
    log,
    callGateway: callGatewayImpl,
    getGatewayHealth: getGatewayHealthImpl,
    exit(code) {
      process.exit(code);
    },
    output(msg) {
      console.log(msg);
    },
    error(msg) {
      console.error(msg);
    },
  };

  return { ...defaults, ...overrides };
}
