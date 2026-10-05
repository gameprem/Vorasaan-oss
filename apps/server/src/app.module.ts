import { Module, StandardSchemaValidationPipe } from '@nestjs/common';
import { APP_GUARD, APP_PIPE } from '@nestjs/core';
import { AiModelsController } from './ai/ai-models.controller.ts';
import { DevFakeAiController } from './ai/dev-fake-ai.controller.ts';
import { MastraModule } from './ai/mastra.module.ts';
import { AiUsageModule } from './ai-usage/ai-usage.module.ts';
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
import { CoverageModule } from './coverage/coverage.module.ts';
import { DecisionRequestsModule } from './decision-requests/decision-requests.module.ts';
import { DecisionStatsModule } from './decision-stats/decision-stats.module.ts';
import {
  DelegationsController,
  MyDelegationsController,
} from './delegations/delegations.controller.ts';
import { DelegationsService } from './delegations/delegations.service.ts';
import { FeatureGuidelinesModule } from './feature-guidelines/feature-guidelines.module.ts';
import { FeatureSuggestionsModule } from './feature-suggestions/feature-suggestions.module.ts';
import { DecisionGraphController } from './features/decision-graph.controller.ts';
import { DecisionGraphService } from './features/decision-graph.service.ts';
import { FeaturesController } from './features/features.controller.ts';
import { GettingStartedModule } from './getting-started/getting-started.module.ts';
import { GrillingModule } from './grilling/grilling.module.ts';
import { HealthController } from './health/health.controller.ts';
import { InboxModule } from './inbox/inbox.module.ts';
import { OrgController } from './org/org.controller.ts';
import { OrgService } from './org/org.service.ts';
import { PlatformsModule } from './platforms/platforms.module.ts';
import { PrismaModule } from './prisma/prisma.module.ts';
import { PromptVersionsModule } from './prompt-versions/prompt-versions.module.ts';
import { ReceiptsModule } from './receipts/receipts.module.ts';
import { RedraftsModule } from './redrafts/redrafts.module.ts';
import { ResponseWindowsModule } from './response-windows/response-windows.module.ts';
import { RetrievalModule } from './retrieval/retrieval.module.ts';
import { AiSettingsController } from './settings/ai-settings.controller.ts';
import { AtlassianModule } from './settings/atlassian.module.ts';
import { SetupController } from './setup/setup.controller.ts';
import { SetupTokenService } from './setup/setup-token.service.ts';
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
    PlatformsModule,
    CoverageModule,
    GrillingModule,
    FeatureSuggestionsModule,
    DecisionRequestsModule,
    DecisionStatsModule,
    SpecModule,
    BriefModule,
    RedraftsModule,
    ReceiptsModule,
    AiUsageModule,
    PromptVersionsModule,
    ConversationsModule,
    ChatAppsModule,
    GettingStartedModule,
  ],
  controllers: [
    HealthController,
    AuthController,
    DevUsersController,
    DevFakeAiController,
    FeaturesController,
    DecisionGraphController,
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
    DecisionGraphService,
    DelegationsService,
    OrgService,
    SetupTokenService,
  ],
})
export class AppModule {}
