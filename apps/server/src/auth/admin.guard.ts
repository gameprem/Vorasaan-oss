import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PrismaClient, User } from '@vorasaan/db';
import { InjectPrisma } from '../prisma/prisma.module.ts';

const ADMIN_ONLY = Symbol('ADMIN_ONLY');

/** Restricts a route (or controller) to Organization Admins. */
export const AdminOnly = () => SetMetadata(ADMIN_ONLY, true);

// Runs after the identity guard, so request.user is already set.
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @InjectPrisma() private readonly db: PrismaClient,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const adminOnly = this.reflector.getAllAndOverride<boolean>(ADMIN_ONLY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!adminOnly) return true;

    const user = context.switchToHttp().getRequest<{ user?: User }>().user;
    const admin = user
      ? await this.db.orgMembership.findFirst({ where: { userId: user.id, role: 'ADMIN' } })
      : null;
    if (!admin) throw new ForbiddenException('Only an Organization Admin can do this');
    return true;
  }
}
