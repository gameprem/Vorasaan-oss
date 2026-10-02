import {
  type CanActivate,
  ConflictException,
  type ExecutionContext,
  HttpException,
  HttpStatus,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import { SETUP_TOKEN_HEADER } from '@vorasaan/shared';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { SetupTokenService } from './setup-token.service.ts';

export const ALREADY_SET_UP = 'Vorasaan is already set up. Sign in instead.';

/**
 * Opens a setup route only while setup is needed and the request carries the Setup Token
 * (ticket 0062). Guards run before body validation, so nothing about the body is checked
 * for someone without the token.
 */
@Injectable()
export class SetupTokenGuard implements CanActivate {
  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly tokens: SetupTokenService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if ((await this.db.organization.count()) > 0) throw new ConflictException(ALREADY_SET_UP);
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      ip: string;
    }>();
    const header = request.headers[SETUP_TOKEN_HEADER];
    const result = this.tokens.check(typeof header === 'string' ? header : undefined, request.ip);
    if (result === 'too-many-tries') {
      throw new HttpException(
        'Too many wrong setup tokens. Wait 15 minutes, or restart the server for a new token.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    if (result === 'invalid') {
      throw new UnauthorizedException(
        'The setup token is missing or wrong. Find it in the server log: docker compose logs server',
      );
    }
    return true;
  }
}
