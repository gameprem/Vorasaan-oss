import { z } from 'zod';
import { AiSettingsInput } from './ai-settings.ts';
import { Password } from './auth.ts';

export const SetupStatus = z.object({ needsSetup: z.boolean() });
export type SetupStatus = z.infer<typeof SetupStatus>;

/** First boot: the Organization, its first Admin, and the AI provider (key required). */
export const SetupInput = z.object({
  organizationName: z.string().trim().min(1, 'Name your organization').max(100),
  admin: z.object({
    name: z.string().trim().min(1, 'Enter your name').max(100),
    email: z.email({ message: 'Enter a valid email' }),
    password: Password,
  }),
  ai: AiSettingsInput.refine((ai) => Boolean(ai.apiKey), {
    message: 'Enter an API key or token',
    path: ['apiKey'],
  }),
});
export type SetupInput = z.infer<typeof SetupInput>;
