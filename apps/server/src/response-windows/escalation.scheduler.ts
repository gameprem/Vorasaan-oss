import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { EscalationJob } from './escalation.job.ts';

/** How often the escalation job runs. */
export const ESCALATION_INTERVAL_MS = 60_000;

/**
 * Runs the escalation job every minute in this process. Every server instance runs it;
 * the job's row locks keep each request to one of them. `VORASAAN_ESCALATION_JOB=off`
 * turns the timer off (tests drive `EscalationJob.run()` with a fake clock instead).
 */
@Injectable()
export class EscalationScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(EscalationScheduler.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<unknown> | undefined;

  constructor(private readonly job: EscalationJob) {}

  onApplicationBootstrap() {
    if (process.env.VORASAAN_ESCALATION_JOB === 'off') return;
    this.timer = setInterval(() => this.tick(), ESCALATION_INTERVAL_MS);
    this.timer.unref?.();
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.running;
  }

  private tick() {
    // A slow run is never overlapped by the next one in the same process.
    if (this.running) return;
    this.running = this.job
      .run()
      .catch((error) => this.logger.error('Escalation run failed', error as Error))
      .finally(() => {
        this.running = undefined;
      });
  }
}
