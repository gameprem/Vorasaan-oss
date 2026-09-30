import { Controller, Get } from '@nestjs/common';
import type { User } from '@vorasaan/db';
import { CurrentUser } from '../dev-identity/dev-user.guard.ts';

@Controller('me')
export class MeController {
  @Get()
  me(@CurrentUser() user: User) {
    return { id: user.id, email: user.email, name: user.name };
  }
}
