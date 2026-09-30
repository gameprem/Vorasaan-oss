import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import { CreateAccessTokenInput, LoginInput, type MeView } from '@vorasaan/shared';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { AuthService } from './auth.service.ts';
import { CurrentToken, CurrentUser, Public } from './identity.guard.ts';

@Controller()
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @InjectPrisma() private readonly db: PrismaClient,
  ) {}

  @Public()
  @Post('auth/login')
  @HttpCode(200)
  login(@Body({ schema: LoginInput }) body: LoginInput) {
    return this.auth.login(body.email, body.password);
  }

  @Post('auth/logout')
  @HttpCode(204)
  async logout(@CurrentToken() token: string | undefined) {
    await this.auth.logout(token);
  }

  @Get('me')
  async me(@CurrentUser() user: User): Promise<MeView> {
    const admin = await this.db.orgMembership.count({ where: { userId: user.id, role: 'ADMIN' } });
    return { id: user.id, email: user.email, name: user.name, isAdmin: admin > 0 };
  }

  @Get('me/tokens')
  tokens(@CurrentUser() user: User) {
    return this.auth.listAccessTokens(user);
  }

  @Post('me/tokens')
  createToken(
    @CurrentUser() user: User,
    @Body({ schema: CreateAccessTokenInput }) body: CreateAccessTokenInput,
  ) {
    return this.auth.createAccessToken(user, body.name);
  }

  @Delete('me/tokens/:id')
  @HttpCode(204)
  async revokeToken(@CurrentUser() user: User, @Param('id', ParseUUIDPipe) id: string) {
    await this.auth.revokeAccessToken(user, id);
  }
}
