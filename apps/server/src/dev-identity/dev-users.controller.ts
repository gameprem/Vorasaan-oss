import { Controller, Get } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { Public } from './dev-user.guard.ts';

// DEV ONLY: feeds the web app's user switcher while x-vorasaan-user stands in for auth.
@Controller('dev/users')
export class DevUsersController {
  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  @Public()
  @Get()
  list() {
    return this.db.user.findMany({
      orderBy: { name: 'asc' },
      select: { id: true, name: true, email: true },
    });
  }
}
