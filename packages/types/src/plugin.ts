import type { ToolDefinition } from './agent.js';
import type { ChannelPlugin } from './channel.js';

/** 플러그인 매니페스트 */
export interface PluginManifest {
  name: string;
  version: string;
  description?: string;
  author?: string;
  main: string;
  type: 'channel' | 'skill' | 'tool' | 'service';
  dependencies?: string[];
  // Phase 5 추가
  slots?: string[];
  config?: Record<string, unknown>;
  configSchema?: unknown;
}

/** HTTP 라우트 등록 */
export interface RouteRegistration {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  handler: (req: unknown, res: unknown) => Promise<void>;
  pluginName: string;
}

/** 플러그인 진단 정보 */
export interface PluginDiagnostic {
  pluginName: string;
  timestamp: number;
  severity: 'info' | 'warn' | 'error';
  phase: 'discovery' | 'manifest' | 'load' | 'register' | 'runtime';
  message: string;
  error?: { code: string; stack?: string };
}

/** 플러그인 레지스트리 (6 → 8슬롯) */
export interface PluginRegistry {
  plugins: RegisteredPlugin[];
  tools: ToolDefinition[];
  channels: ChannelPlugin[];
  hooks: PluginHook[];
  services: PluginService[];
  commands: PluginCommand[];
  routes: RouteRegistration[];
  diagnostics: PluginDiagnostic[];
}

/** 등록된 플러그인 */
export interface RegisteredPlugin {
  manifest: PluginManifest;
  status: 'active' | 'disabled' | 'error';
  error?: string;
  loadedAt: number;
}

/** 플러그인 훅 */
export interface PluginHook {
  name: PluginHookName;
  priority: number;
  handler: (...args: unknown[]) => Promise<unknown>;
  pluginName: string;
}

/** 훅 이름 열거 (7 → 9종) */
export type PluginHookName =
  | 'beforeMessageProcess'
  | 'afterMessageProcess'
  | 'beforeAgentRun'
  | 'afterAgentRun'
  | 'onConfigChange'
  | 'onGatewayStart'
  | 'onGatewayStop'
  | 'onPluginLoaded'
  | 'onPluginUnloaded'
  | 'beforeToolExecute' // Phase 7
  | 'afterToolExecute'; // Phase 7

/** 플러그인 서비스 */
export interface PluginService {
  name: string;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** 플러그인 커맨드 */
export interface PluginCommand {
  name: string;
  description: string;
  handler: (args: string[]) => Promise<string>;
  pluginName: string;
}
