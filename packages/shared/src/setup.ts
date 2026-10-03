import { z } from 'zod';
import { AiSettingsInput } from './ai-settings.ts';
import { Password } from './auth.ts';
import { ChatLanguage } from './chat-apps.ts';
import { WorkingTimeInput } from './response-window.ts';

export const SetupStatus = z.object({ needsSetup: z.boolean() });
export type SetupStatus = z.infer<typeof SetupStatus>;

/**
 * The header that carries the Setup Token on `POST /setup` and `POST /setup/test-ai`
 * (ticket 0062). While setup is needed, the server prints the token to its log at startup.
 */
export const SETUP_TOKEN_HEADER = 'x-vorasaan-setup-token';

/**
 * First boot: the Organization, its first Admin, its Working Time and language, and the AI
 * provider (key required). Working Time and language are optional so an older client still
 * works: left out, the Organization keeps the defaults (UTC, Monday to Friday 09:00-18:00,
 * English). Given, Working Time needs every field, the time zone included.
 */
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
  /** The Organization's time zone, working days and hours, which Response Windows count in. */
  workingTime: WorkingTimeInput.optional(),
  /** The Organization's default language for chat app cards and bot replies (ticket 0063). */
  language: ChatLanguage.optional(),
});
export type SetupInput = z.infer<typeof SetupInput>;
