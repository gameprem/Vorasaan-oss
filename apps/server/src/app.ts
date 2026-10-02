import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module.ts';
import { installVerbatimBody } from './http/verbatim-body.ts';

// Shared by main.ts and tests so both boot the exact same app.
export async function createApp(): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter();
  installVerbatimBody(adapter.getInstance());
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, adapter, {
    logger: process.env.NODE_ENV === 'test' ? false : undefined,
  });
  app.enableShutdownHooks();
  return app;
}
