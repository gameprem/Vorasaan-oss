import {
  type CanActivate,
  createParamDecorator,
  type ExecutionContext,
  Injectable,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PrismaClient, User } from '@vorasaan/db';
import { InjectPrisma } from '../prisma/prisma.module.ts';

// DEV ONLY. Stands in for real auth during the tracer bullet: the caller names
// itself with a User id in this header. Replaced by sessions + PATs in the MVP.
export const DEV_USER_HEADER = 'x-vorasaan-user';

const IS_PUBLIC = Symbol('IS_PUBLIC');
export const Public = () => SetMetadata(IS_PUBLIC, true);

type RequestWithUser = { headers: Record<string, string | string[] | undefined>; user?: User };

@Injectable()
export class DevUserGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectPrisma() private readonly db: PrismaClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const request = context.switchToHttp().getRequest<RequestWithUser>();
    const userId = request.headers[DEV_USER_HEADER];
    if (typeof userId !== 'string' || userId === '') {
      throw new UnauthorizedException(`Missing ${DEV_USER_HEADER} header`);
    }

    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user) throw new UnauthorizedException('Unknown user');

    request.user = user;
    return true;
  }
}

export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): User => {
    const user = context.switchToHttp().getRequest<RequestWithUser>().user;
    if (!user) throw new UnauthorizedException();
    return user;
  },
);
