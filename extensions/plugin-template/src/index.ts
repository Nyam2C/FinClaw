/**
 * FinClaw 플러그인 템플릿
 *
 * register()로 채널, 훅, 서비스, 커맨드, 라우트를 등록한다.
 * PluginBuildApi를 통해 FinClaw의 슬롯 시스템에 접근할 수 있다.
 *
 * @see packages/server/src/plugins/loader.ts — PluginBuildApi 인터페이스 정의
 */

/** PluginBuildApi 축약 타입 (원본: packages/server/src/plugins/loader.ts) */
interface PluginApi {
  readonly pluginName: string;
  registerHook(
    hookName: string,
    handler: (...args: unknown[]) => Promise<unknown>,
    opts?: { priority?: number },
  ): void;
  registerCommand(command: {
    name: string;
    description: string;
    handler: (args: string[]) => Promise<string>;
  }): void;
}

export function register(api: PluginApi): void {
  // 훅 등록 예시: 에이전트 실행 완료 후 로깅
  api.registerHook(
    'afterAgentRun',
    async (payload) => {
      console.log(`[${api.pluginName}] Agent run completed`, payload);
    },
    { priority: 100 },
  );

  // 커맨드 등록 예시
  api.registerCommand({
    name: 'my-command',
    description: 'An example command provided by this plugin',
    handler: async (_args) => 'Command executed successfully',
  });
}

export async function deactivate(): Promise<void> {
  // 플러그인 해제 시 리소스 정리
}
