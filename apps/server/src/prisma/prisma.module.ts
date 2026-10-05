import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createPrismaClient, type PrismaClient, poolSizeFromEnv } from '@vorasaan/db';

export const PRISMA = Symbol('PRISMA');

// Inject with `@InjectPrisma() private readonly db: PrismaClient`.
export const InjectPrisma = () => Inject(PRISMA);

@Global()
@Module({
  providers: [
    {
      provide: PRISMA,
      useFactory: (): PrismaClient => {
        const url = process.env.DATABASE_URL;
        if (!url) throw new Error('DATABASE_URL is not set');
        // DATABASE_POOL_SIZE: connections per server process (docs/performance.md).
        return createPrismaClient(url, { poolSize: poolSizeFromEnv() });
      },
    },
  ],
  exports: [PRISMA],
})
export class PrismaModule implements OnApplicationShutdown {
  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  async onApplicationShutdown() {
    await this.db.$disconnect();
  }
}
