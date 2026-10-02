import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { AiModelsController } from './ai/ai-models.controller.ts';
import { DevFakeAiController } from './ai/dev-fake-ai.controller.ts';
import { MastraModule } from './ai/mastra.module.ts';
import { AttachmentsModule } from './attachments/attachments.module.ts';
import { AdminGuard } from './auth/admin.guard.ts';
import { AuthController } from './auth/auth.controller.ts';
import { AuthService } from './auth/auth.service.ts';
import { DevUsersController } from './auth/dev-users.controller.ts';
import { IdentityGuard } from './auth/identity.guard.ts';
import { BriefModule } from './brief/brief.module.ts';
import { ChatAppsModule } from './chat-apps/chat-apps.module.ts';
import { ClockModule } from './clock/clock.ts';
import { ConversationsModule } from './conversations/conversations.module.ts';
import { DecisionRequestsModule } from './decision-requests/decision-requests.module.ts';
import { DecisionStatsModule } from './decision-stats/decision-stats.module.ts';
import {
  DelegationsController,
  MyDelegationsController,
} from './delegations/delegations.controller.ts';
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
import { ResponseWindowsModule } from './response-windows/response-windows.module.ts';
import { RetrievalModule } from './retrieval/retrieval.module.ts';
import { AiSettingsController } from './settings/ai-settings.controller.ts';
import { AtlassianModule } from './settings/atlassian.module.ts';
import { SetupController } from './setup/setup.controller.ts';
import { SpecModule } from './spec/spec.module.ts';

@Module({
  imports: [
    PrismaModule,
    ClockModule,
    MastraModule,
    RetrievalModule,
    AtlassianModule,
    AttachmentsModule,
    InboxModule,
    ResponseWindowsModule,
    FeatureGuidelinesModule,
    GrillingModule,
    FeatureSuggestionsModule,
    DecisionRequestsModule,
    DecisionStatsModule,
    SpecModule,
    BriefModule,
    ConversationsModule,
    ChatAppsModule,
  ],
  controllers: [
    HealthController,
    AuthController,
    DevUsersController,
    DevFakeAiController,
    FeaturesController,
    DelegationsController,
    MyDelegationsController,
    AiSettingsController,
    AiModelsController,
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
    DelegationsService,
    OrgService,
  ],
})
export class AppModule {}
