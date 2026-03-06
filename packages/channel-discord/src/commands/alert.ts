import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand, CommandDeps } from '../types.js';
import { buildAlertEmbed } from '../embeds.js';

export const alertCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('alert')
    .setDescription('가격 알림을 관리합니다')
    .addSubcommand((sub) =>
      sub
        .setName('set')
        .setDescription('새 가격 알림을 설정합니다')
        .addStringOption((opt) =>
          opt.setName('ticker').setDescription('종목 코드').setRequired(true),
        )
        .addStringOption((opt) =>
          opt
            .setName('condition')
            .setDescription('조건')
            .setRequired(true)
            .addChoices(
              { name: '이상', value: 'above' },
              { name: '이하', value: 'below' },
              { name: '변동률(%)', value: 'change_percent' },
            ),
        )
        .addNumberOption((opt) => opt.setName('value').setDescription('기준 값').setRequired(true)),
    )
    .addSubcommand((sub) => sub.setName('list').setDescription('설정된 알림 목록을 조회합니다'))
    .addSubcommand((sub) =>
      sub
        .setName('remove')
        .setDescription('알림을 삭제합니다')
        .addStringOption((opt) => opt.setName('id').setDescription('알림 ID').setRequired(true)),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
    if (!deps.alertStorage) {
      await interaction.reply({
        content: '알림 기능은 아직 준비 중입니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const subcommand = interaction.options.getSubcommand();

    switch (subcommand) {
      case 'set': {
        const ticker = interaction.options.getString('ticker', true);
        const condition = interaction.options.getString('condition', true);
        const value = interaction.options.getNumber('value', true);
        // TODO: createAlert 호출
        await interaction.reply({
          content: `알림 설정 완료: ${ticker} ${condition} ${value}`,
          flags: MessageFlags.Ephemeral,
        });
        break;
      }
      case 'list': {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const alerts = await deps.alertStorage.getAlerts(interaction.user.id);
        const embeds = alerts.map((a) => buildAlertEmbed(a));
        await interaction.editReply({ embeds });
        break;
      }
      case 'remove': {
        const id = interaction.options.getString('id', true);
        await deps.alertStorage.deleteAlert(id);
        await interaction.reply({ content: `알림 ${id} 삭제 완료`, flags: MessageFlags.Ephemeral });
        break;
      }
    }
  },
};
