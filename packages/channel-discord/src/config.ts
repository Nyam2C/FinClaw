import { z } from 'zod/v4';

export const DiscordAccountSchema = z
  .strictObject({
    botToken: z.string(),
    applicationId: z.string(),
    guildIds: z.array(z.string()).optional(),
    allowDMs: z.boolean().default(true),
    typingIntervalMs: z.number().int().min(1000).default(5000),
    maxChunkLength: z.number().int().min(500).max(2000).default(2000),
    maxChunkLines: z.number().int().min(5).max(50).default(17),
    approvalRequired: z.boolean().default(false),
    approvalTimeoutMs: z.number().int().min(10_000).default(300_000), // 5분
  })
  .readonly();

export type DiscordAccount = z.infer<typeof DiscordAccountSchema>;
