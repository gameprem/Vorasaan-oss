import { Controller, Get, NotFoundException } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { devAuthEnabled, Public } from './identity.guard.ts';

// DEV ONLY: feeds the web app's user switcher. 404 unless VORASAAN_DEV_AUTH=true.
@Controller('dev/users')
export class DevUsersController {
  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  @Public()
  @Get()
  list() {
    if (!devAuthEnabled()) throw new NotFoundException();
    return this.db.user.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true },
    });
  }
}
