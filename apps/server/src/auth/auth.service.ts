import { Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import type { PrismaClient, User } from '@vorasaan/db';
import type { AccessTokenView, CreatedAccessToken, LoginResult } from '@vorasaan/shared';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { hashToken, newToken, PAT_PREFIX, SESSION_PREFIX, SESSION_TTL_MS } from './tokens.ts';

export function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: 'argon2id' });
}

@Injectable()
export class AuthService {
  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  async login(email: string, password: string): Promise<LoginResult> {
    const user = await this.db.user.findUnique({ where: { email: email.toLowerCase() } });
    // Verify even when the user is unknown so timing doesn't reveal which emails exist.
    const ok = await Bun.password
      .verify(password, user?.passwordHash ?? DUMMY_HASH)
      .catch(() => false);
    if (!user || !ok) throw new UnauthorizedException('Wrong email or password');
    return this.startSession(user);
  }

  async startSession(user: User): Promise<LoginResult> {
    const token = newToken(SESSION_PREFIX);
    const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
    await this.db.session.create({
      data: { userId: user.id, tokenHash: hashToken(token), expiresAt },
    });
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: user.id, name: user.name, email: user.email },
    };
  }

  async logout(token: string | undefined) {
    if (token?.startsWith(SESSION_PREFIX)) {
      await this.db.session.deleteMany({ where: { tokenHash: hashToken(token) } });
    }
  }

  async userForToken(token: string): Promise<User | null> {
    const tokenHash = hashToken(token);
    const now = new Date();
    if (token.startsWith(SESSION_PREFIX)) {
      const session = await this.db.session.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
      return session && session.expiresAt > now ? session.user : null;
    }
    if (token.startsWith(PAT_PREFIX)) {
      const pat = await this.db.personalAccessToken.findUnique({
        where: { tokenHash },
        include: { user: true },
      });
      if (!pat || pat.revokedAt || (pat.expiresAt && pat.expiresAt <= now)) return null;
      await this.db.personalAccessToken.update({
        where: { id: pat.id },
        data: { lastUsedAt: now },
      });
      return pat.user;
    }
    return null;
  }

  /**
   * Whether `token` still signs in `userId`: the session or Personal Access Token exists,
   * is not revoked and has not expired. Unlike `userForToken` it writes nothing, so a
   * long-lived stream can re-check on every heartbeat.
   */
  async tokenIsLive(token: string, userId: string): Promise<boolean> {
    const tokenHash = hashToken(token);
    const now = new Date();
    if (token.startsWith(SESSION_PREFIX)) {
      const session = await this.db.session.findUnique({ where: { tokenHash } });
      return !!session && session.userId === userId && session.expiresAt > now;
    }
    if (token.startsWith(PAT_PREFIX)) {
      const pat = await this.db.personalAccessToken.findUnique({ where: { tokenHash } });
      return (
        !!pat && pat.userId === userId && !pat.revokedAt && (!pat.expiresAt || pat.expiresAt > now)
      );
    }
    return false;
  }

  userById(id: string) {
    return this.db.user.findUnique({ where: { id } }).catch(() => null);
  }

  async createAccessToken(user: User, name: string): Promise<CreatedAccessToken> {
    const token = newToken(PAT_PREFIX);
    const pat = await this.db.personalAccessToken.create({
      data: { userId: user.id, name, tokenHash: hashToken(token) },
    });
    return { ...toView(pat), token };
  }

  async listAccessTokens(user: User): Promise<AccessTokenView[]> {
    const pats = await this.db.personalAccessToken.findMany({
      where: { userId: user.id, revokedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return pats.map(toView);
  }

  async revokeAccessToken(user: User, id: string) {
    const { count } = await this.db.personalAccessToken.updateMany({
      where: { id, userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw new NotFoundException('Token not found');
  }
}

// A valid argon2id hash of a random string, used only to equalize timing.
const DUMMY_HASH = await hashPassword(crypto.randomUUID());

function toView(p: {
  id: string;
  name: string;
  createdAt: Date;
  lastUsedAt: Date | null;
}): AccessTokenView {
  return {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt.toISOString(),
    lastUsedAt: p.lastUsedAt?.toISOString() ?? null,
  };
}
