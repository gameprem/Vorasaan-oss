import { Global, Inject, Module } from '@nestjs/common';

/** The current time. Services that schedule by time read it here, so tests can move it. */
export interface Clock {
  now(): Date;
}

export const CLOCK = Symbol('CLOCK');

// Inject with `@InjectClock() private readonly clock: Clock`.
export const InjectClock = () => Inject(CLOCK);

export const systemClock: Clock = { now: () => new Date() };

@Global()
@Module({
  providers: [{ provide: CLOCK, useValue: systemClock }],
  exports: [CLOCK],
})
export class ClockModule {}
