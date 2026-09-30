import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { MastraModule } from './ai/mastra.module.ts';
import { DecisionRequestsController } from './decision-requests/decision-requests.controller.ts';
import { DecisionRequestsService } from './decision-requests/decision-requests.service.ts';
import { DevUserGuard } from './dev-identity/dev-user.guard.ts';
import { DevUsersController } from './dev-identity/dev-users.controller.ts';
import { FeaturesController } from './features/features.controller.ts';
import { HealthController } from './health/health.controller.ts';
import { MeController } from './me/me.controller.ts';
import { PrismaModule } from './prisma/prisma.module.ts';
import { SpecController } from './spec/spec.controller.ts';
import { SpecService } from './spec/spec.service.ts';

@Module({
  imports: [PrismaModule, MastraModule],
  controllers: [
    HealthController,
    MeController,
    DevUsersController,
    FeaturesController,
    DecisionRequestsController,
    SpecController,
  ],
  providers: [
    { provide: APP_GUARD, useClass: DevUserGuard },
    // Validates any @Body/@Query/@Param declared with `{ schema }` (Zod via Standard Schema, ADR 0004).
    { provide: APP_PIPE, useValue: new StandardSchemaValidationPipe() },
    DecisionRequestsService,
    SpecService,
  ],
})
export class AppModule {}
