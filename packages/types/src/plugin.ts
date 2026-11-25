/** Phase 29 D: stdio MCP 서버 spec — manifest.mcpServers 에 선언 */
export interface MCPServerSpec {
  /** plugin 내 식별자 (고유) — 도구 namespace 의 prefix (mcp:<id>:<tool>) */
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
  /** 도구 호출 timeout (ms). 미지정 시 30_000 */
  readonly timeoutMs?: number;
}

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
  /** Phase 29 D: stdio MCP 서버 등록. 도구는 ToolRegistry 에 group='mcp' 로 자동 등록. */
  mcpServers?: readonly MCPServerSpec[];
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
