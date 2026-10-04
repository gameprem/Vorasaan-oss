import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma, PrismaClient, User } from '@vorasaan/db';
import {
  CHAT_LINK_CODE_MINUTES,
  CHAT_PROVIDER_LABEL,
  type ChatEventKind,
  ChatLanguage,
  type ChatLinkCodeView,
  type ChatPreferencesInput,
  type ChatPreferencesView,
  ChatProvider,
  DEFAULT_CHAT_EVENTS,
  DEFAULT_CHAT_LANGUAGE,
  DEFAULT_RESPONSE_WINDOW_SETTINGS,
  type MyChatAppsView,
  minutesOfDay,
  timeOfDay,
} from '@vorasaan/shared';
import { personLanguage } from '../ai/language.ts';
import { type Clock, InjectClock } from '../clock/clock.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import type { ChatAddress, ChatUser } from './adapters/adapter.ts';
import { ChatApiError } from './adapters/http.ts';
import { ChatAdapters } from './chat-adapters.ts';
import { ChatAppSettingsService } from './chat-app-settings.service.ts';
import { chatText } from './chat-text.ts';
import type { ChatDeliveryPreferences } from './delivery.ts';
import { hashLinkCode, LinkAttempts, newLinkCode } from './link-code.ts';

export type LinkResult =
  | { kind: 'linked'; name: string }
  | { kind: 'invalid' }
  | { kind: 'too-many-tries' }
  | { kind: 'linked-to-someone-else' };

/**
 * Chat Accounts (ticket 0057): a person links their LINE, Slack or Teams account with a
 * one-time code they send to the bot, and unlinks it from Vorasaan or from the chat.
 * Also their chat preferences: which events go there, and quiet hours.
 */
@Injectable()
export class ChatAccountsService {
  private readonly logger = new Logger(ChatAccountsService.name);
  /** Wrong codes per chat account (5 per 15 minutes). */
  readonly attempts = new LinkAttempts();

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    @InjectClock() private readonly clock: Clock,
    private readonly settings: ChatAppSettingsService,
    private readonly adapters: ChatAdapters,
    private readonly bus: EventBus,
  ) {}

  /** The instance's Organization, which the person must belong to. */
  private async organizationOf(user: Pick<User, 'id'>): Promise<string> {
    const organizationId = await this.settings.organizationId();
    const member =
      organizationId &&
      (await this.db.orgMembership.findFirst({
        where: { userId: user.id, organizationId },
        select: { id: true },
      }));
    if (!organizationId || !member) {
      throw new ForbiddenException('You are not a member of an Organization');
    }
    return organizationId;
  }

  async mine(user: User): Promise<MyChatAppsView> {
    const organizationId = await this.organizationOf(user);
    const [enabled, accounts, preferences] = await Promise.all([
      this.settings.enabled(organizationId),
      this.db.chatAccount.findMany({ where: { userId: user.id, organizationId } }),
      this.preferences(user),
    ]);
    return {
      apps: ChatProvider.options.map((provider) => {
        const account = accounts.find((a) => a.provider === provider);
        return {
          provider,
          enabled: enabled.has(provider),
          account: account
            ? {
                provider,
                displayName: account.displayName,
                linkedAt: account.createdAt.toISOString(),
              }
            : null,
        };
      }),
      preferences,
    };
  }

  /**
   * A new one-time code for the person to send to the bot. Only its hash is stored;
   * any earlier unused code of theirs for that chat app stops working.
   */
  async createLinkCode(user: User, provider: ChatProvider): Promise<ChatLinkCodeView> {
    const organizationId = await this.organizationOf(user);
    if (!(await this.settings.enabled(organizationId)).has(provider)) {
      throw new ConflictException(`An Admin hasn't turned on ${CHAT_PROVIDER_LABEL[provider]}`);
    }
    const code = newLinkCode();
    const now = this.clock.now();
    const expiresAt = new Date(now.getTime() + CHAT_LINK_CODE_MINUTES * 60_000);
    await this.db.$transaction([
      this.db.chatLinkCode.deleteMany({ where: { userId: user.id, provider } }),
      this.db.chatLinkCode.create({
        data: {
          organizationId,
          userId: user.id,
          provider,
          codeHash: hashLinkCode(code.replace('-', '')),
          expiresAt,
          createdAt: now,
        },
      }),
    ]);
    return { provider, code, expiresAt: expiresAt.toISOString() };
  }

  /** Unlinks from Vorasaan, and tells the chat account so (best effort). */
  async unlink(user: User, provider: ChatProvider): Promise<void> {
    const organizationId = await this.organizationOf(user);
    const account = await this.db.chatAccount.findUnique({
      where: { userId_provider: { userId: user.id, provider } },
    });
    if (!account || account.organizationId !== organizationId) {
      throw new NotFoundException(`No ${CHAT_PROVIDER_LABEL[provider]} account is linked`);
    }
    await this.db.chatAccount.delete({ where: { id: account.id } });
    this.changed(user.id, provider, false);
    const t = chatText(await this.languageOf(user.id));
    await this.notify(provider, account, { text: t.unlinkedBy(user.name) });
  }

  private async notify(
    provider: ChatProvider,
    account: { providerUserId: string; address: Prisma.JsonValue },
    message: { text: string },
  ): Promise<void> {
    try {
      const connection = await this.settings.connection(provider);
      if (!connection) return;
      await this.adapters
        .get(provider)
        .send(connection.credentials, { ...account, address: toAddress(account.address) }, message);
    } catch (error) {
      this.logger.warn(
        error instanceof ChatApiError ? error.message : `Could not message ${provider}`,
      );
    }
  }

  // ─── From the chat side ───────────────────────────────────────────────────

  /** Links the chat account that sent `code` to the person the code was made for. */
  async linkFromChat(
    organizationId: string,
    provider: ChatProvider,
    chatUser: ChatUser,
    code: string,
  ): Promise<LinkResult> {
    const now = this.clock.now();
    const key = `${provider}:${chatUser.id}`;
    if (this.attempts.blocked(key, now.getTime())) return { kind: 'too-many-tries' };
    let result: LinkResult & { userId?: string };
    try {
      result = await this.db.$transaction(async (tx) => {
        const row = await tx.chatLinkCode.findUnique({
          where: { codeHash: hashLinkCode(code) },
          include: { user: { select: { name: true } } },
        });
        if (
          !row ||
          row.provider !== provider ||
          row.organizationId !== organizationId ||
          row.usedAt ||
          row.expiresAt <= now
        ) {
          return { kind: 'invalid' as const };
        }
        const member = await tx.orgMembership.findFirst({
          where: { userId: row.userId, organizationId },
          select: { id: true },
        });
        if (!member) return { kind: 'invalid' as const };
        const taken = await tx.chatAccount.findUnique({
          where: {
            organizationId_provider_providerUserId: {
              organizationId,
              provider,
              providerUserId: chatUser.id,
            },
          },
        });
        if (taken && taken.userId !== row.userId)
          return { kind: 'linked-to-someone-else' as const };
        const used = await tx.chatLinkCode.updateMany({
          where: { id: row.id, usedAt: null },
          data: { usedAt: now },
        });
        if (used.count !== 1) return { kind: 'invalid' as const };
        // One account per person per chat app: a new link replaces the old one.
        await tx.chatAccount.deleteMany({
          where: { userId: row.userId, provider, NOT: { providerUserId: chatUser.id } },
        });
        await tx.chatAccount.upsert({
          where: {
            organizationId_provider_providerUserId: {
              organizationId,
              provider,
              providerUserId: chatUser.id,
            },
          },
          create: {
            organizationId,
            userId: row.userId,
            provider,
            providerUserId: chatUser.id,
            address: chatUser.address,
            displayName: chatUser.displayName,
            createdAt: now,
          },
          update: { address: chatUser.address, displayName: chatUser.displayName },
        });
        return { kind: 'linked' as const, name: row.user.name, userId: row.userId };
      });
    } catch (error) {
      // Linked by someone else between our read and write.
      if ((error as { code?: string })?.code === 'P2002') {
        return { kind: 'linked-to-someone-else' };
      }
      throw error;
    }
    if (result.kind === 'invalid') this.attempts.fail(key, now.getTime());
    if (result.kind === 'linked' && result.userId) {
      this.attempts.clear(key);
      this.changed(result.userId, provider, true);
      return { kind: 'linked', name: result.name };
    }
    return result;
  }

  /** Unlinks a chat account from its side ("unlink", or the bot was removed). */
  async unlinkFromChat(
    organizationId: string,
    provider: ChatProvider,
    providerUserId: string,
  ): Promise<boolean> {
    const account = await this.accountFor(organizationId, provider, providerUserId);
    if (!account) return false;
    const { count } = await this.db.chatAccount.deleteMany({ where: { id: account.id } });
    if (count) this.changed(account.userId, provider, false);
    return count > 0;
  }

  /** The person a chat account is linked to, if any. */
  accountFor(organizationId: string, provider: ChatProvider, providerUserId: string) {
    return this.db.chatAccount.findUnique({
      where: {
        organizationId_provider_providerUserId: { organizationId, provider, providerUserId },
      },
      include: { user: { select: { id: true, name: true } } },
    });
  }

  private changed(userId: string, provider: ChatProvider, linked: boolean) {
    this.bus.emit(userId, { event: 'chatAccount.changed', data: { provider, linked } });
  }

  // ─── Preferences ──────────────────────────────────────────────────────────

  private async organizationTimeZone(organizationId: string): Promise<string> {
    const settings = await this.db.responseWindowSettings.findUnique({
      where: { organizationId },
      select: { timeZone: true },
    });
    return settings?.timeZone ?? DEFAULT_RESPONSE_WINDOW_SETTINGS.timeZone;
  }

  /** The Organization's language (ticket 0063): for anyone who hasn't picked their own. */
  async organizationLanguage(organizationId: string): Promise<ChatLanguage> {
    const org = await this.db.organization.findUnique({
      where: { id: organizationId },
      select: { language: true },
    });
    return chatLanguage(org?.language) ?? DEFAULT_CHAT_LANGUAGE;
  }

  async preferences(user: Pick<User, 'id'>): Promise<ChatPreferencesView> {
    const organizationId = await this.organizationOf(user);
    const [row, orgTimeZone, orgLanguage] = await Promise.all([
      this.db.chatPreference.findUnique({ where: { userId: user.id } }),
      this.organizationTimeZone(organizationId),
      this.organizationLanguage(organizationId),
    ]);
    const language = chatLanguage(row?.language);
    const quiet =
      row?.quietStartMinute != null && row.quietEndMinute != null
        ? { start: timeOfDay(row.quietStartMinute), end: timeOfDay(row.quietEndMinute) }
        : null;
    return {
      events: row ? [...row.events] : [...DEFAULT_CHAT_EVENTS],
      quietHours: quiet,
      timeZone: row?.timeZone ?? null,
      effectiveTimeZone: row?.timeZone ?? orgTimeZone,
      language,
      effectiveLanguage: language ?? orgLanguage,
    };
  }

  async savePreferences(user: User, input: ChatPreferencesInput): Promise<ChatPreferencesView> {
    await this.organizationOf(user);
    const data = {
      events: input.events as ChatEventKind[],
      quietStartMinute: input.quietHours ? minutesOfDay(input.quietHours.start) : null,
      quietEndMinute: input.quietHours ? minutesOfDay(input.quietHours.end) : null,
      timeZone: input.timeZone,
      // Left out (an older client): unchanged.
      ...(input.language !== undefined && { language: input.language }),
    };
    await this.db.chatPreference.upsert({
      where: { userId: user.id },
      create: { userId: user.id, ...data },
      update: data,
    });
    return this.preferences(user);
  }

  /** What is asked before sending a card (see delivery.ts), and the card's language. */
  async deliveryPreferences(user: Pick<User, 'id'>): Promise<ChatDeliveryPreferences> {
    const view = await this.preferences(user);
    return {
      events: view.events,
      quietStartMinute: view.quietHours ? minutesOfDay(view.quietHours.start) : null,
      quietEndMinute: view.quietHours ? minutesOfDay(view.quietHours.end) : null,
      timeZone: view.effectiveTimeZone,
      language: view.effectiveLanguage,
    };
  }

  /** The language a person reads cards and bot replies in: their own, else the Organization's. */
  async languageOf(userId: string): Promise<ChatLanguage> {
    // The same language the AI replies to them in (ticket 0068).
    return personLanguage(this.db, userId);
  }
}

function chatLanguage(value: string | null | undefined): ChatLanguage | null {
  const parsed = ChatLanguage.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function toAddress(value: Prisma.JsonValue): ChatAddress {
  const out: ChatAddress = {};
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value)) if (typeof v === 'string') out[k] = v;
  }
  return out;
}
