// packages/server/src/auto-reply/commands/built-in.ts
import type { AgentRunPort, ProfileHealthMonitor, ToolRegistry } from '@finclaw/agent';
import type { MarketSkillHandle, NewsSkillHandle } from '@finclaw/skills-finance';
import type { ModelRef, StorageAdapter } from '@finclaw/types';
import type { CommandRegistry } from './registry.js';
import { createResetCommand } from './reset.js';
import { createStatusCommand } from './status.js';

export interface BuiltInCommandDeps {
  readonly toolRegistry?: ToolRegistry;
  readonly storage: StorageAdapter;
  /** reset 명령이 세션 lane 을 거쳐 지우도록. */
  readonly runtime: Pick<AgentRunPort, 'reset'>;
  readonly profileHealth?: ProfileHealthMonitor;
  readonly profileId?: string;
  readonly defaultModel?: ModelRef;
  /** Phase 27 D: status 명령의 provider 한도 표시용. */
  readonly marketHandle?: MarketSkillHandle;
  readonly newsHandle?: NewsSkillHandle;
}

/** 내장 명령어 등록 (toolRegistry 미제공 시 status 미등록) */
export function registerBuiltInCommands(registry: CommandRegistry, deps: BuiltInCommandDeps): void {
  // /help - 도움말
  registry.register(
    {
      name: 'help',
      aliases: ['h', '도움말'],
      description: '사용 가능한 명령어 목록을 표시합니다',
      usage: '/help [명령어]',
    },
    async (args) => {
      if (args.length > 0) {
        const cmd = registry.get(args[0]);
        if (cmd) {
          return {
            content: `**/${cmd.definition.name}**\n${cmd.definition.description}\n사용법: \`${cmd.definition.usage}\``,
            ephemeral: true,
          };
        }
        return { content: `알 수 없는 명령어: ${args[0]}`, ephemeral: true };
      }
      const commands = registry.list();
      let output = '**사용 가능한 명령어:**\n\n';
      for (const cmd of commands) {
        output += `  \`/${cmd.name}\` - ${cmd.description}\n`;
      }
      return { content: output, ephemeral: true };
    },
  );

  // /reset - 세션 초기화
  registry.register(
    {
      name: 'reset',
      aliases: ['clear', '초기화'],
      description: '현재 대화 세션을 초기화합니다',
      usage: '/reset',
    },
    createResetCommand({ reset: (key) => deps.runtime.reset(key) }),
  );

  // /status - 서버 상태
  if (deps.toolRegistry) {
    registry.register(
      {
        name: 'status',
        aliases: ['상태'],
        description: 'FinClaw 서버 상태를 표시합니다',
        usage: '/status',
      },
      createStatusCommand({
        toolRegistry: deps.toolRegistry,
        storage: deps.storage,
        profileHealth: deps.profileHealth,
        profileId: deps.profileId,
        defaultModel: deps.defaultModel,
        marketHandle: deps.marketHandle,
        newsHandle: deps.newsHandle,
      }),
    );
  }
}
