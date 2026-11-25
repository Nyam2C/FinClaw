import { z } from 'zod/v4';

export const DiscordAccountSchema = z
  .strictObject({
    botToken: z.string(),
  })
  .readonly();

export type DiscordAccount = z.infer<typeof DiscordAccountSchema>;
