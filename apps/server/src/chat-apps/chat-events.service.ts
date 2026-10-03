import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import type { ChatLanguage, ChatProvider } from '@vorasaan/shared';
import { type Clock, InjectClock } from '../clock/clock.ts';
import type { ChatInbound, InboundRequest } from './adapters/adapter.ts';
import { ChatAccountsService, type LinkResult } from './chat-accounts.service.ts';
import { ChatActionsService } from './chat-actions.service.ts';
import { ChatAdapters } from './chat-adapters.ts';
import { ChatAppSettingsService } from './chat-app-settings.service.ts';
import { failure } from './chat-cards.service.ts';
import { CANCEL_WORDS, type ChatText, chatText } from './chat-text.ts';
import { linkCodeIn, SeenEvents } from './link-code.ts';

type Message = Extract<ChatInbound, { kind: 'message' }>;

const UNLINK_COMMANDS = new Set(['unlink', '/unlink', 'unlink vorasaan']);

/**
 * `POST /chat-apps/:provider/events` (ADR 0011): checks the callback's signature with
 * the Organization's secret for that chat app before anything reads the body, then
 * handles what the person did: a link code, "unlink", anything else (a short help), or
 * a card's button (ticket 0058). Presses are answered in the background, so the
 * provider gets its acknowledgement at once (Slack wants one within 3 seconds) while a
 * Decision drafts its Spec Proposal.
 */
@Injectable()
export class ChatEventsService {
  private readonly logger = new Logger(ChatEventsService.name);
  private readonly seen = new SeenEvents();
  private readonly running = new Set<Promise<void>>();

  constructor(
    @InjectClock() private readonly clock: Clock,
    private readonly settings: ChatAppSettingsService,
    private readonly accounts: ChatAccountsService,
    private readonly adapters: ChatAdapters,
    private readonly actions: ChatActionsService,
  ) {}

  /** Returns the body the provider expects back, if any. Unsigned: 401, nothing else. */
  async handle(provider: ChatProvider, request: InboundRequest): Promise<unknown> {
    const connection = await this.settings.connection(provider);
    if (!connection) throw new UnauthorizedException();
    const adapter = this.adapters.get(provider);
    const now = this.clock.now();
    const verified = await adapter.verify(request, connection.credentials, now);
    if (verified === null) throw new UnauthorizedException();
    const parsed = adapter.parse(request, verified, connection.credentials);
    if (!parsed) throw new UnauthorizedException();
    const { organizationId } = connection;

    for (const event of parsed.events) {
      // A redelivered or replayed event (same id, still validly signed) does nothing twice.
      if (event.eventId && !this.seen.firstTime(`${provider}:${event.eventId}`, now.getTime())) {
        continue;
      }
      if (event.kind === 'unlinked') {
        await this.accounts.unlinkFromChat(organizationId, provider, event.userId);
      } else if (event.kind === 'action') {
        this.background(() => this.actions.press({ organizationId, provider, ...event }));
      } else {
        // LINE: the text behind "Ask for more info" or "Write your own answer".
        // "unlink" or a link code is still that, even with a prompt waiting.
        const command =
          UNLINK_COMMANDS.has(event.text.trim().toLowerCase()) || linkCodeIn(event.text);
        const prompt = this.actions.takePrompt(provider, event.user.id);
        if (prompt && command) {
          await this.message(organizationId, provider, event);
        } else if (prompt && !CANCEL_WORDS.has(event.text.trim().toLowerCase())) {
          this.background(() =>
            this.actions.press({
              organizationId,
              provider,
              user: event.user,
              token: prompt,
              text: event.text,
              reply: event.reply,
            }),
          );
        } else if (prompt) {
          await this.say(
            event,
            provider,
            chatText(await this.languageOf(organizationId, provider, event)).cancelled,
          );
        } else {
          await this.message(organizationId, provider, event);
        }
      }
    }
    return parsed.response;
  }

  private background(work: () => Promise<void>) {
    const run = work()
      .catch((error) => this.logger.error(failure(error, 'A chat app press failed')))
      .finally(() => this.running.delete(run));
    this.running.add(run);
  }

  /** Waits for presses being answered (tests, shutdown). */
  async drain(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  private async languageOf(
    organizationId: string,
    provider: ChatProvider,
    event: Message,
  ): Promise<ChatLanguage> {
    const account = await this.accounts.accountFor(organizationId, provider, event.user.id);
    return account
      ? this.accounts.languageOf(account.userId)
      : this.accounts.organizationLanguage(organizationId);
  }

  private async message(organizationId: string, provider: ChatProvider, event: Message) {
    const text = event.text.trim();
    let reply: string;
    if (UNLINK_COMMANDS.has(text.toLowerCase())) {
      const t = chatText(await this.languageOf(organizationId, provider, event));
      const unlinked = await this.accounts.unlinkFromChat(organizationId, provider, event.user.id);
      reply = unlinked ? t.unlinkedFromChat : t.notLinked(provider);
    } else {
      const code = linkCodeIn(text);
      if (code) {
        const result = await this.accounts.linkFromChat(organizationId, provider, event.user, code);
        reply = linkReply(
          result,
          chatText(await this.languageOf(organizationId, provider, event)),
          provider,
        );
      } else {
        const account = await this.accounts.accountFor(organizationId, provider, event.user.id);
        const t = chatText(
          account
            ? await this.accounts.languageOf(account.userId)
            : await this.accounts.organizationLanguage(organizationId),
        );
        reply = account ? t.linkedAs(account.user.name) : t.howToLink(provider);
      }
    }
    await this.say(event, provider, reply);
  }

  private async say(event: Message, provider: ChatProvider, text: string) {
    try {
      await event.reply({ text });
    } catch (error) {
      this.logger.warn(failure(error, `Could not reply on ${provider}`));
    }
  }
}

function linkReply(result: LinkResult, t: ChatText, provider: ChatProvider): string {
  switch (result.kind) {
    case 'linked':
      return t.linked(result.name);
    case 'too-many-tries':
      return t.tooManyTries;
    case 'linked-to-someone-else':
      return t.linkedToSomeoneElse(provider);
    case 'invalid':
      return t.invalidCode;
  }
}
