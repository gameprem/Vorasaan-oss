import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { MastraModule } from './ai/mastra.module.ts';
import { AttachmentsModule } from './attachments/attachments.module.ts';
import { AdminGuard } from './auth/admin.guard.ts';
import { AuthController } from './auth/auth.controller.ts';
import { AuthService } from './auth/auth.service.ts';
import { DevUsersController } from './auth/dev-users.controller.ts';
import { IdentityGuard } from './auth/identity.guard.ts';
import { BriefController } from './brief/brief.controller.ts';
import { BriefService } from './brief/brief.service.ts';
import { DecisionRequestsController } from './decision-requests/decision-requests.controller.ts';
import { DecisionRequestsService } from './decision-requests/decision-requests.service.ts';
import { DelegationsController } from './delegations/delegations.controller.ts';
import { DelegationsService } from './delegations/delegations.service.ts';
import { FeatureGuidelinesModule } from './feature-guidelines/feature-guidelines.module.ts';
import { FeatureSuggestionsModule } from './feature-suggestions/feature-suggestions.module.ts';
import { FeaturesController } from './features/features.controller.ts';
import { GrillingModule } from './grilling/grilling.module.ts';
import { HealthController } from './health/health.controller.ts';
import { InboxModule } from './inbox/inbox.module.ts';
import { OrgController } from './org/org.controller.ts';
import { OrgService } from './org/org.service.ts';
import { PrismaModule } from './prisma/prisma.module.ts';
import { RetrievalModule } from './retrieval/retrieval.module.ts';
import { AiSettingsController } from './settings/ai-settings.controller.ts';
import { AtlassianModule } from './settings/atlassian.module.ts';
import { SetupController } from './setup/setup.controller.ts';
import { SpecController } from './spec/spec.controller.ts';
import { SpecService } from './spec/spec.service.ts';

@Module({
  imports: [
    PrismaModule,
    MastraModule,
    RetrievalModule,
    AtlassianModule,
    AttachmentsModule,
    InboxModule,
    FeatureGuidelinesModule,
    GrillingModule,
    FeatureSuggestionsModule,
  ],
  controllers: [
    HealthController,
    AuthController,
    DevUsersController,
    FeaturesController,
    DecisionRequestsController,
    DelegationsController,
    SpecController,
    BriefController,
    AiSettingsController,
    SetupController,
    OrgController,
  ],
  providers: [
    // Order matters: identity first, then role checks.
    { provide: APP_GUARD, useClass: IdentityGuard },
    { provide: APP_GUARD, useClass: AdminGuard },
    // Validates any @Body/@Query/@Param declared with `{ schema }` (Zod via Standard Schema, ADR 0004).
    { provide: APP_PIPE, useValue: new StandardSchemaValidationPipe() },
    AuthService,
    DecisionRequestsService,
    DelegationsService,
    SpecService,
    BriefService,
    OrgService,
  ],
})
export class AppModule {}
