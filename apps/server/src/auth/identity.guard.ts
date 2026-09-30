import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { User } from '@vorasaan/db';
import { AuthService } from './auth.service.ts';

/**
 * DEV ONLY: with VORASAAN_DEV_AUTH=true the caller may name itself with a User id
 * in this header (tests, seeded local demos). Ignored otherwise.
 */
export const DEV_USER_HEADER = 'x-vorasaan-user';

export function devAuthEnabled(env: Record<string, string | undefined> = process.env) {
  return env.VORASAAN_DEV_AUTH === 'true';
}

const IS_PUBLIC = Symbol('IS_PUBLIC');
export const Public = () => SetMetadata(IS_PUBLIC, true);

type RequestWithUser = {
  headers: Record<string, string | string[] | undefined>;
  user?: User;
  authToken?: string;
};

/** Resolves the caller from `Authorization: Bearer <session token | PAT>`. */
@Injectable()
export class IdentityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly auth: AuthService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    const request = context.switchToHttp().getRequest<RequestWithUser>();

    const header = request.headers.authorization;
    const bearer =
      typeof header === 'string' && header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (bearer) {
      const user = await this.auth.userForToken(bearer);
      if (user) {
        request.user = user;
        request.authToken = bearer;
        return true;
      }
      if (!isPublic) throw new UnauthorizedException('Your session expired. Sign in again.');
    }

    const devUserId = request.headers[DEV_USER_HEADER];
    if (devAuthEnabled() && typeof devUserId === 'string' && devUserId) {
      const user = await this.auth.userById(devUserId);
      if (!user) throw new UnauthorizedException('Unknown user');
      request.user = user;
      return true;
    }

    if (isPublic) return true;
    throw new UnauthorizedException('Sign in to continue');
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User => {
    const user = context.switchToHttp().getRequest<RequestWithUser>().user;
    if (!user) throw new UnauthorizedException();
    return user;
  },
);

/** The bearer token the request authenticated with (to sign out that session). */
export const CurrentToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    context.switchToHttp().getRequest<RequestWithUser>().authToken,
);
