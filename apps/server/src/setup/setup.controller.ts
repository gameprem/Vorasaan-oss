import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import {
  AiSettingsInput,
  DEFAULT_CHAT_LANGUAGE,
  DEFAULT_RESPONSE_WINDOW_SETTINGS,
  GeminiModelsInput,
  type LoginResult,
  minutesOfDay,
  SetupInput,
  type SetupStatus,
} from '@vorasaan/shared';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import { AuthService, hashPassword } from '../auth/auth.service.ts';
import { Public } from '../auth/identity.guard.ts';
import { SecretBox } from '../crypto/secret-box.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { ALREADY_SET_UP, SetupTokenGuard } from './setup-token.guard.ts';
import { SetupTokenService } from './setup-token.service.ts';

/**
 * First boot: the Organization with its Working Time and language, its first Admin, and the
 * AI provider. Every route here is public and works only until an Organization exists;
 * all but the status also need the Setup Token (ticket 0062).
 */
@Public()
@Controller('setup')
export class SetupController {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly auth: AuthService,
    private readonly ai: AiSettingsService,
    private readonly tokens: SetupTokenService,
  ) {}

  @Get('status')
  async status(): Promise<SetupStatus> {
    return { needsSetup: (await this.db.organization.count()) === 0 };
  }

  /** Lets the wizard check the provider before any Admin exists. */
  @Post('test-ai')
  @HttpCode(200)
  @UseGuards(SetupTokenGuard)
  async testAi(@Body({ schema: AiSettingsInput }) body: AiSettingsInput) {
    return this.ai.test(body);
  }

  /** OpenRouter's model list, for the provider step (ticket 0064). No key is needed. */
  @Post('openrouter-models')
  @HttpCode(200)
  @UseGuards(SetupTokenGuard)
  async openRouterModels() {
    return this.ai.openRouterModels();
  }

  /**
   * The Gemini API's model list, for the provider step (ticket 0080). The Gemini API
   * lists models only for a key, so the wizard sends the one typed; it is not stored.
   */
  @Post('gemini-models')
  @HttpCode(200)
  @UseGuards(SetupTokenGuard)
  async geminiModels(@Body({ schema: GeminiModelsInput }) body: GeminiModelsInput) {
    return this.ai.geminiModels(body.apiKey);
  }

  @Post()
  @HttpCode(201)
  @UseGuards(SetupTokenGuard)
  async setup(@Body({ schema: SetupInput }) body: SetupInput): Promise<LoginResult> {
    // Fail before writing anything if secrets can't be encrypted.
    try {
      SecretBox.fromEnv();
    } catch (error) {
      throw new UnprocessableEntityException((error as Error).message);
    }
    this.ai.assertSetupInput(body.ai);
    const passwordHash = await hashPassword(body.admin.password);

    const { organizationId, user } = await this.db
      .$transaction(
        async (tx) => {
          if ((await tx.organization.count()) > 0) {
            throw new ConflictException(ALREADY_SET_UP);
          }
          const organization = await tx.organization.create({
            data: { name: body.organizationName, language: body.language ?? DEFAULT_CHAT_LANGUAGE },
          });
          // The working calendar Response Windows count in (ticket 0063), with the default
          // windows. Left out by an older client: no row, so the defaults apply.
          if (body.workingTime) {
            const { blocker, question } = DEFAULT_RESPONSE_WINDOW_SETTINGS;
            await tx.responseWindowSettings.create({
              data: {
                organizationId: organization.id,
                timeZone: body.workingTime.timeZone,
                workingDays: [...body.workingTime.workingDays].sort((a, b) => a - b),
                workStartMinute: minutesOfDay(body.workingTime.workStart),
                workEndMinute: minutesOfDay(body.workingTime.workEnd),
                blockerWindow: blocker.value,
                blockerWindowUnit: blocker.unit,
                questionWindow: question.value,
                questionWindowUnit: question.unit,
              },
            });
          }
          const user = await tx.user.create({
            data: {
              name: body.admin.name,
              email: body.admin.email.toLowerCase(),
              passwordHash,
            },
          });
          await tx.orgMembership.create({
            data: { organizationId: organization.id, userId: user.id, role: 'ADMIN' },
          });
          return { organizationId: organization.id, user };
        },
        { isolationLevel: 'Serializable' },
      )
      .catch(lostTheRace);
    // Spent the moment the Organization exists, whatever happens next.
    this.tokens.invalidate();

    await this.ai.setupFirst(body.ai, organizationId);
    return this.auth.startSession(user);
  }
}

/** Two setups at once: Postgres aborts the loser's serializable transaction (P2034). */
function lostTheRace(error: unknown): never {
  if ((error as { code?: string })?.code === 'P2034') throw new ConflictException(ALREADY_SET_UP);
  throw error;
}
