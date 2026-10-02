import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ChatCardsService } from './chat-cards.service.ts';

/** How often cards held by Quiet Hours are looked at again. */
export const CHAT_CARDS_INTERVAL_MS = 60_000;

/**
 * Sends the cards Quiet Hours held back once they are over, every minute in this
 * process. A card is claimed with a conditional update before it is sent, so several
 * instances never send one twice. `VORASAAN_CHAT_CARDS_JOB=off` turns the timer off
 * (tests call `ChatCardsService.flush()` with a fake clock instead).
 */
@Injectable()
export class ChatCardsScheduler implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ChatCardsScheduler.name);
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<unknown> | undefined;

  constructor(private readonly cards: ChatCardsService) {}

  onApplicationBootstrap() {
    if (process.env.VORASAAN_CHAT_CARDS_JOB === 'off') return;
    this.timer = setInterval(() => this.tick(), CHAT_CARDS_INTERVAL_MS);
    this.timer.unref?.();
  }

  async onApplicationShutdown() {
    clearInterval(this.timer);
    await this.running;
    await this.cards.drain();
  }

  private tick() {
    if (this.running) return;
    this.running = this.cards
      .flush()
      .catch(() => this.logger.error('Sending held chat cards failed'))
      .finally(() => {
        this.running = undefined;
      });
  }
}
