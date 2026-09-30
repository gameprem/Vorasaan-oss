import { Global, Inject, Module, type OnApplicationShutdown } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@vorasaan/db';

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
        return createPrismaClient(url);
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
