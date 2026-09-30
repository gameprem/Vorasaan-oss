import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { MastraModule } from './ai/mastra.module.ts';
import { DevUserGuard } from './dev-identity/dev-user.guard.ts';
import { HealthController } from './health/health.controller.ts';
import { MeController } from './me/me.controller.ts';
import { PrismaModule } from './prisma/prisma.module.ts';

@Module({
  imports: [PrismaModule, MastraModule],
  controllers: [HealthController, MeController],
  providers: [{ provide: APP_GUARD, useClass: DevUserGuard }],
})
export class AppModule {}
