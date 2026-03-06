import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand, CommandDeps } from '../types.js';
import { buildMarketEmbed } from '../embeds.js';

export const marketCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('market')
    .setDescription('주식/암호화폐 시세를 조회합니다')
    .addStringOption((option) =>
      option
        .setName('ticker')
        .setDescription('종목 코드 (예: AAPL, 005930.KS, BTC-USD)')
        .setRequired(true),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
    // 미구현 시 "준비 중" 응답
    if (!deps.financeService) {
      await interaction.reply({
        content: '시세 조회 기능은 아직 준비 중입니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const ticker = interaction.options.getString('ticker', true);
    await interaction.deferReply();

    try {
      const quote = await deps.financeService.getQuote(ticker);
      const embed = buildMarketEmbed(quote);
      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      await interaction.editReply({
        content: `시세 조회 실패: ${(error as Error).message}`,
      });
    }
  },
};
