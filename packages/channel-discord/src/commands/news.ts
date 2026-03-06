import { SlashCommandBuilder, MessageFlags, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand, CommandDeps } from '../types.js';
import { buildNewsEmbed } from '../embeds.js';

export const newsCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('news')
    .setDescription('금융 뉴스를 검색합니다')
    .addStringOption((option) =>
      option
        .setName('query')
        .setDescription('검색어 (예: 삼성전자, 금리, FOMC)')
        .setRequired(false),
    )
    .addIntegerOption((option) =>
      option.setName('count').setDescription('뉴스 개수 (기본 5)').setMinValue(1).setMaxValue(10),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, deps: CommandDeps): Promise<void> {
    if (!deps.financeService) {
      await interaction.reply({
        content: '뉴스 검색 기능은 아직 준비 중입니다.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    const query = interaction.options.getString('query') ?? '주요 금융 뉴스';
    const count = interaction.options.getInteger('count') ?? 5;

    await interaction.deferReply();

    // TODO: searchNews 호출에 try-catch 추가 — 외부 API 실패 시 사용자에게 에러 메시지 표시
    const articles = await deps.financeService.searchNews(query, count);
    const embeds = articles.map((a) => buildNewsEmbed(a));
    await interaction.editReply({ embeds });
  },
};
