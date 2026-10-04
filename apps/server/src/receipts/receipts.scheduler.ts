import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ReceiptsService } from './receipts.service.ts';

/** How often Receipts past the retention are deleted. */
export const RECEIPTS_PURGE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes Receipts past the Organization's retention once a day, and once at start.
 * `VORASAAN_RECEIPTS_JOB=off` turns it off (tests run `ReceiptsService.purge()` with a
 * fake clock instead). Several instances may run it: deleting twice is harmless.
 */
@Injectable()
export class ReceiptsScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ReceiptsScheduler.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<unknown> | undefined;

  constructor(private readonly receipts: ReceiptsService) {}

  onApplicationBootstrap() {
    if (process.env.VORASAAN_RECEIPTS_JOB === 'off') return;
    this.tick();
    this.timer = setInterval(() => this.tick(), RECEIPTS_PURGE_INTERVAL_MS);
    this.timer.unref?.();
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.running;
    await this.receipts.drain();
  }

  private tick() {
    if (this.running) return;
    this.running = this.receipts
      .purge()
      .then(({ receipts }) => {
        if (receipts) this.logger.log(`Deleted ${receipts} Receipts past the retention`);
      })
      .catch((error) => this.logger.error('Deleting old Receipts failed', error as Error))
      .finally(() => {
        this.running = undefined;
      });
  }
}
