import type { Clock } from '../clock/clock.ts';

/** A Clock tests set and move. Until set, it reads the real time. */
export class FakeClock implements Clock {
  private fixed: Date | undefined;

  now(): Date {
    return this.fixed ? new Date(this.fixed) : new Date();
  }

  set(at: Date | string): void {
    this.fixed = new Date(at);
  }

  advance(ms: number): void {
    this.fixed = new Date(this.now().getTime() + ms);
  }

  /** Back to the real time. */
  reset(): void {
    this.fixed = undefined;
  }
}
