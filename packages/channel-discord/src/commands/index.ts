import { createLogger } from '@finclaw/infra';
import { retry } from '@finclaw/infra';
import { REST, Routes, MessageFlags, type Client } from 'discord.js';
import type { DiscordAccount, SlashCommand, CommandDeps } from '../types.js';
import { alertCommand } from './alert.js';
import { askCommand } from './ask.js';
import { marketCommand } from './market.js';
import { newsCommand } from './news.js';

const log = createLogger({ name: 'channel-discord' });

const commands: SlashCommand[] = [askCommand, marketCommand, newsCommand, alertCommand];

/**
 * 슬래시 커맨드를 Discord에 등록한다.
 * retry() 사용으로 REST API 일시 장애 대응.
 */
export async function registerGuildCommands(client: Client, config: DiscordAccount): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.botToken);
  const commandData = commands.map((cmd) => cmd.data.toJSON());

  if (config.guildIds?.length) {
    for (const guildId of config.guildIds) {
      await retry(
        () =>
          rest.put(Routes.applicationGuildCommands(config.applicationId, guildId), {
            body: commandData,
          }),
        { maxAttempts: 3 },
      );
      log.info(`Registered ${commands.length} commands for guild ${guildId}`);
    }
  } else {
    await retry(
      () => rest.put(Routes.applicationCommands(config.applicationId), { body: commandData }),
      { maxAttempts: 3 },
    );
    log.info(`Registered ${commands.length} global commands`);
  }
}

/** 인터랙션 라우터 설정 */
export function setupCommandRouter(client: Client, deps: CommandDeps): void {
  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) {
      return;
    }

    const command = commands.find((cmd) => cmd.data.name === interaction.commandName);
    if (!command) {
      return;
    }

    try {
      await command.execute(interaction, deps);
    } catch (error) {
      log.error('Command execution error', { command: interaction.commandName, error });
      const content = `명령 실행 중 오류가 발생했습니다.`;
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content, flags: MessageFlags.Ephemeral });
      } else {
        await interaction.reply({ content, flags: MessageFlags.Ephemeral });
      }
    }
  });
}
