// packages/server/src/auto-reply/commands/built-in.ts
import type { CommandRegistry } from './registry.js';

/** 내장 명령어 등록 */
export function registerBuiltInCommands(registry: CommandRegistry): void {
  // /help - 도움말
  registry.register(
    {
      name: 'help',
      aliases: ['h', '도움말'],
      description: '사용 가능한 명령어 목록을 표시합니다',
      usage: '/help [명령어]',
      category: 'general',
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
      category: 'general',
    },
    async () => ({
      content: '대화 세션이 초기화되었습니다. 새로운 대화를 시작해 주세요.',
      ephemeral: false,
    }),
  );

  // /price - 시세 조회
  registry.register(
    {
      name: 'price',
      aliases: ['시세', 'quote'],
      description: '종목의 현재 시세를 조회합니다',
      usage: '/price AAPL (또는 /price 삼성전자)',
      category: 'finance',
    },
    async (args) => {
      if (args.length === 0) {
        return { content: '종목 심볼을 입력해 주세요. 예: `/price AAPL`', ephemeral: true };
      }
      return {
        content: `${args[0]} 시세 조회 기능은 skills-finance 모듈 연동 후 활성화됩니다.`,
        ephemeral: false,
      };
    },
  );

  // /portfolio - 포트폴리오 조회
  registry.register(
    {
      name: 'portfolio',
      aliases: ['포트폴리오', 'pf'],
      description: '현재 포트폴리오 요약을 표시합니다',
      usage: '/portfolio',
      category: 'finance',
    },
    async () => ({
      content: '포트폴리오 조회 기능은 skills-finance 모듈 연동 후 활성화됩니다.',
      ephemeral: false,
    }),
  );

  // /alert - 알림 설정
  registry.register(
    {
      name: 'alert',
      aliases: ['알림'],
      description: '가격 알림을 설정합니다',
      usage: '/alert AAPL > 200 (AAPL이 $200 이상일 때 알림)',
      category: 'finance',
    },
    async (args) => {
      if (args.length < 3) {
        return {
          content: '사용법: `/alert 종목 조건 가격`\n예: `/alert AAPL > 200`',
          ephemeral: true,
        };
      }
      return {
        content: '알림 설정 기능은 skills-finance 모듈 연동 후 활성화됩니다.',
        ephemeral: false,
      };
    },
  );
}
