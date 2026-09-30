import { Controller, Get } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import { Public } from '../dev-identity/dev-user.guard.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';

@Controller('health')
export class HealthController {
  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  @Public()
  @Get()
  async check() {
    await this.db.$queryRaw`SELECT 1`;
    return { ok: true };
  }
}
