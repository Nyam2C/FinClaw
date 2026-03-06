import { SlashCommandBuilder, type ChatInputCommandInteraction } from 'discord.js';
import type { SlashCommand, CommandDeps } from '../types.js';
import { chunkText } from '../chunking.js';

export const askCommand: SlashCommand = {
  data: new SlashCommandBuilder()
    .setName('ask')
    .setDescription('FinClaw AI에게 질문합니다')
    .addStringOption((option) =>
      option.setName('question').setDescription('질문 내용').setRequired(true),
    ) as SlashCommandBuilder,

  async execute(interaction: ChatInputCommandInteraction, _deps: CommandDeps): Promise<void> {
    const question = interaction.options.getString('question', true);

    await interaction.deferReply();

    // TODO: 실행 엔진 통합 — Phase 9 runner 호출
    const result = `[placeholder] ${question}에 대한 AI 응답`;
    const chunks = chunkText(result, 2000, 17);

    await interaction.editReply({ content: chunks[0] });

    for (let i = 1; i < chunks.length; i++) {
      await interaction.followUp({ content: chunks[i] });
    }
  },
};
