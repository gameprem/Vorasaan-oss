import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { CHAT_LINK_CODE_MINUTES, CHAT_PROVIDER_LABEL, type ChatProvider } from '@vorasaan/shared';
import { type Clock, InjectClock } from '../clock/clock.ts';
import type { ChatInbound, InboundRequest } from './adapters/adapter.ts';
import { ChatApiError } from './adapters/http.ts';
import { ChatAccountsService, type LinkResult } from './chat-accounts.service.ts';
import { ChatAdapters } from './chat-adapters.ts';
import { ChatAppSettingsService } from './chat-app-settings.service.ts';
import { linkCodeIn, SeenEvents } from './link-code.ts';

type Message = Extract<ChatInbound, { kind: 'message' }>;

const UNLINK_COMMANDS = new Set(['unlink', '/unlink', 'unlink vorasaan']);

/**
 * `POST /chat-apps/:provider/events` (ADR 0011): checks the callback's signature with
 * the Organization's secret for that chat app before anything reads the body, then
 * handles what the person wrote. In 0057 that is a link code, "unlink", or anything
 * else (a short help). Ticket 0058 adds button presses.
 */
@Injectable()
export class ChatEventsService {
  private readonly logger = new Logger(ChatEventsService.name);
  private readonly seen = new SeenEvents();

  constructor(
    @InjectClock() private readonly clock: Clock,
    private readonly settings: ChatAppSettingsService,
    private readonly accounts: ChatAccountsService,
    private readonly adapters: ChatAdapters,
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

    for (const event of parsed.events) {
      // A redelivered or replayed event (same id, still validly signed) does nothing twice.
      if (event.eventId && !this.seen.firstTime(`${provider}:${event.eventId}`, now.getTime())) {
        continue;
      }
      if (event.kind === 'unlinked') {
        await this.accounts.unlinkFromChat(connection.organizationId, provider, event.userId);
      } else {
        await this.message(connection.organizationId, provider, event);
      }
    }
    return parsed.response;
  }

  private async message(organizationId: string, provider: ChatProvider, event: Message) {
    const label = CHAT_PROVIDER_LABEL[provider];
    const text = event.text.trim();
    let reply: string;
    if (UNLINK_COMMANDS.has(text.toLowerCase())) {
      const unlinked = await this.accounts.unlinkFromChat(organizationId, provider, event.user.id);
      reply = unlinked
        ? "Unlinked from Vorasaan. You won't get Decision Requests here any more."
        : `This ${label} account isn't linked to Vorasaan.`;
    } else {
      const code = linkCodeIn(text);
      if (code) {
        reply = linkReply(
          await this.accounts.linkFromChat(organizationId, provider, event.user, code),
          label,
        );
      } else {
        const account = await this.accounts.accountFor(organizationId, provider, event.user.id);
        reply = account
          ? `You're linked to Vorasaan as ${account.user.name}. Send "unlink" to disconnect.`
          : `To link this ${label} account to Vorasaan, open Settings → Notifications in Vorasaan, choose "Link ${label}", and send the code here.`;
      }
    }
    try {
      await event.reply({ text: reply });
    } catch (error) {
      this.logger.warn(
        error instanceof ChatApiError ? error.message : `Could not reply on ${provider}`,
      );
    }
  }
}

function linkReply(result: LinkResult, label: string): string {
  switch (result.kind) {
    case 'linked':
      return `Linked to Vorasaan as ${result.name}. Decision Requests sent to you can arrive here. Send "unlink" to disconnect.`;
    case 'too-many-tries':
      return 'Too many wrong codes. Wait 15 minutes, then send a new code from Vorasaan.';
    case 'linked-to-someone-else':
      return `This ${label} account is already linked to another person in Vorasaan. Send "unlink" first, then your code again.`;
    case 'invalid':
      return `That code didn't work. It may be mistyped, already used or expired (a code lasts ${CHAT_LINK_CODE_MINUTES} minutes). Get a new one in Vorasaan under Settings → Notifications.`;
  }
}
