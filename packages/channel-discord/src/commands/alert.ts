import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import { buildAlertEmbed } from '../embeds.js';
import type { SlashCommand, CommandDeps } from '../types.js';

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

        // TODO(R10): v2 alertStorage → v3 AlertStore 마이그레이션 필요
        const alert = await deps.alertStorage.createAlert({
          name: `${ticker} ${condition} ${value}`,
          symbol: ticker as import('@finclaw/types').TickerSymbol,
          condition: {
            type: condition as import('@finclaw/types').AlertConditionType,
            value,
          },
          enabled: true,
          triggerCount: 0,
          cooldownMs: 900_000,
          createdAt: Date.now() as import('@finclaw/types').Timestamp,
        });

        await interaction.reply({
          content: `알림 설정 완료: ${alert.name} (ID: ${alert.id})`,
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
