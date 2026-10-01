import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Post,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import { AiSettingsInput, type LoginResult, SetupInput, type SetupStatus } from '@vorasaan/shared';
import { AiSettingsService } from '../ai/ai-settings.service.ts';
import { AuthService, hashPassword } from '../auth/auth.service.ts';
import { Public } from '../auth/identity.guard.ts';
import { SecretBox } from '../crypto/secret-box.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';

/** First boot. Every route here is public and works only until an Organization exists. */
@Public()
@Controller('setup')
export class SetupController {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly auth: AuthService,
    private readonly ai: AiSettingsService,
  ) {}

  @Get('status')
  async status(): Promise<SetupStatus> {
    return { needsSetup: (await this.db.organization.count()) === 0 };
  }

  /** Lets the wizard check the provider before any Admin exists. */
  @Post('test-ai')
  @HttpCode(200)
  async testAi(@Body({ schema: AiSettingsInput }) body: AiSettingsInput) {
    await this.assertNeedsSetup();
    return this.ai.test(body);
  }

  @Post()
  @HttpCode(201)
  async setup(@Body({ schema: SetupInput }) body: SetupInput): Promise<LoginResult> {
    // Fail before writing anything if secrets can't be encrypted.
    try {
      SecretBox.fromEnv();
    } catch (error) {
      throw new UnprocessableEntityException((error as Error).message);
    }
    const passwordHash = await hashPassword(body.admin.password);

    const { organizationId, user } = await this.db.$transaction(
      async (tx) => {
        if ((await tx.organization.count()) > 0) {
          throw new ConflictException('Vorasaan is already set up. Sign in instead.');
        }
        const organization = await tx.organization.create({
          data: { name: body.organizationName },
        });
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
    );

    await this.ai.setupFirst(body.ai, organizationId);
    return this.auth.startSession(user);
  }

  private async assertNeedsSetup() {
    if ((await this.db.organization.count()) > 0) {
      throw new ConflictException('Vorasaan is already set up');
    }
  }
}
