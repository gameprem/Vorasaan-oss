import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { OrgIntegration, PrismaClient } from '@vorasaan/db';
import {
  type ChatAppSettingsInput,
  type ChatAppSettingsView,
  type ChatAppsSettingsView,
  ChatProvider,
  chatEventsPath,
} from '@vorasaan/shared';
import { SecretBox } from '../crypto/secret-box.ts';
import { EventBus } from '../inbox/event-bus.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { findSingleIntegration, saveSingleIntegration } from '../settings/single-integration.ts';
import type { ChatCredentials } from './adapters/adapter.ts';
import { ChatAdapters } from './chat-adapters.ts';

/** The secrets each chat app needs, stored together as one encrypted JSON object. */
const SECRET_FIELDS = {
  LINE: ['channelAccessToken', 'channelSecret'],
  SLACK: ['botToken', 'signingSecret'],
  TEAMS: ['appPassword'],
} as const satisfies Record<ChatProvider, readonly string[]>;

const FIELD_LABEL: Record<string, string> = {
  channelAccessToken: 'the channel access token',
  channelSecret: 'the channel secret',
  botToken: 'the bot token',
  signingSecret: 'the signing secret',
  appPassword: 'the bot app password',
};

/** The Organization a chat app's credentials belong to, decrypted. */
export type ChatConnection<P extends ChatProvider> = {
  organizationId: string;
  credentials: ChatCredentials[P];
};

/**
 * Settings → Chat apps (ticket 0057): the Organization's LINE channel, Slack app and
 * Teams bot, each an OrgIntegration whose secrets are encrypted with
 * VORASAAN_SECRET_KEY. Secrets leave this service only decrypted for the adapters
 * (signature checks, the Authorization header of provider API calls); views say
 * whether they are set, never what they are.
 */
@Injectable()
export class ChatAppSettingsService {
  private box: SecretBox | undefined;

  constructor(
    @InjectPrisma() private readonly db: PrismaClient,
    private readonly adapters: ChatAdapters,
    private readonly bus: EventBus,
  ) {}

  /** Lazily, so the server still boots (and says why) without VORASAAN_SECRET_KEY. */
  private secrets(): SecretBox {
    this.box ??= SecretBox.fromEnv();
    return this.box;
  }

  /**
   * Self-hosted: one Organization per instance, as for Atlassian and AI providers. Chat
   * callbacks carry no Vorasaan identity, so they are checked with this Organization's
   * secrets (ADR 0011, ticket 0057 Decisions).
   */
  async organizationId(): Promise<string | undefined> {
    const org = await this.db.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return org?.id;
  }

  private async requireOrganizationId(): Promise<string> {
    const id = await this.organizationId();
    if (!id) throw new UnprocessableEntityException('Run setup first');
    return id;
  }

  /** Decrypts a chat app's secrets. A failure never says what was stored. */
  private storedSecrets(integration: OrgIntegration): Record<string, string> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.secrets().decrypt(integration.secretEncrypted));
    } catch {
      throw new Error(`The stored ${integration.provider} credentials could not be read`);
    }
    const out: Record<string, string> = {};
    if (parsed && typeof parsed === 'object') {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === 'string') out[key] = value;
      }
    }
    return out;
  }

  async view(): Promise<ChatAppsSettingsView> {
    const organizationId = await this.organizationId();
    if (!organizationId) return { apps: ChatProvider.options.map((p) => this.toView(p, null, 0)) };
    const [integrations, counts] = await Promise.all([
      this.db.orgIntegration.findMany({
        where: { organizationId, provider: { in: [...ChatProvider.options] } },
      }),
      this.db.chatAccount.groupBy({
        by: ['provider'],
        where: { organizationId },
        _count: { _all: true },
      }),
    ]);
    return {
      apps: ChatProvider.options.map((provider) =>
        this.toView(
          provider,
          integrations.find((i) => i.provider === provider) ?? null,
          counts.find((c) => c.provider === provider)?._count._all ?? 0,
        ),
      ),
    };
  }

  private toView(
    provider: ChatProvider,
    integration: OrgIntegration | null,
    linkedAccounts: number,
  ): ChatAppSettingsView {
    return {
      provider,
      enabled: Boolean(integration),
      appId: integration?.appId ?? null,
      secretsSet: Boolean(integration?.secretEncrypted),
      eventsPath: chatEventsPath(provider),
      linkedAccounts,
      updatedAt: integration?.updatedAt.toISOString() ?? null,
    };
  }

  /** Turns a chat app on, or changes its credentials. Left-out secrets keep the stored ones. */
  async save(input: ChatAppSettingsInput): Promise<ChatAppSettingsView> {
    const organizationId = await this.requireOrganizationId();
    const { provider } = input;
    const existing = await findSingleIntegration(this.db, organizationId, provider);
    const appId = input.provider === 'TEAMS' ? input.appId : null;
    const newBot = input.provider === 'TEAMS' && existing !== null && existing.appId !== appId;

    // A stored password is only reused for the same bot, never sent for another app id.
    const merged: Record<string, string> = existing && !newBot ? this.storedSecrets(existing) : {};
    const given = input as Record<string, unknown>;
    for (const field of SECRET_FIELDS[provider]) {
      const value = given[field];
      if (typeof value === 'string' && value) merged[field] = value;
    }
    const missing = SECRET_FIELDS[provider].find((field) => !merged[field]);
    if (missing) {
      throw new UnprocessableEntityException(
        newBot
          ? `Enter ${FIELD_LABEL[missing]} again for the new app id`
          : `Enter ${FIELD_LABEL[missing]}`,
      );
    }
    const secrets = Object.fromEntries(SECRET_FIELDS[provider].map((f) => [f, merged[f]]));
    await saveSingleIntegration(this.db, organizationId, provider, {
      secretEncrypted: this.secrets().encrypt(JSON.stringify(secrets)),
      appId,
    });
    if (provider === 'TEAMS') this.adapters.TEAMS.forgetTokens();
    // A Teams user id is per bot: links made with another bot no longer identify anyone.
    if (newBot) await this.unlinkAll(organizationId, provider);
    return this.viewOf(organizationId, provider);
  }

  /** Turns a chat app off: its credentials, links and pending codes are deleted. */
  async turnOff(provider: ChatProvider): Promise<ChatAppSettingsView> {
    const organizationId = await this.requireOrganizationId();
    await this.unlinkAll(organizationId, provider, true);
    return this.viewOf(organizationId, provider);
  }

  private async unlinkAll(
    organizationId: string,
    provider: ChatProvider,
    removeIntegration = false,
  ) {
    const accounts = await this.db.$transaction(async (tx) => {
      const linked = await tx.chatAccount.findMany({
        where: { organizationId, provider },
        select: { userId: true },
      });
      await tx.chatAccount.deleteMany({ where: { organizationId, provider } });
      await tx.chatLinkCode.deleteMany({ where: { organizationId, provider } });
      if (removeIntegration) {
        await tx.orgIntegration.deleteMany({ where: { organizationId, provider } });
      }
      return linked;
    });
    for (const { userId } of accounts) {
      this.bus.emit(userId, { event: 'chatAccount.changed', data: { provider, linked: false } });
    }
  }

  private async viewOf(organizationId: string, provider: ChatProvider) {
    const [integration, linked] = await Promise.all([
      findSingleIntegration(this.db, organizationId, provider),
      this.db.chatAccount.count({ where: { organizationId, provider } }),
    ]);
    return this.toView(provider, integration, linked);
  }

  /** The chat apps an Admin turned on. */
  async enabled(organizationId: string): Promise<Set<ChatProvider>> {
    const rows = await this.db.orgIntegration.findMany({
      where: { organizationId, provider: { in: [...ChatProvider.options] } },
      select: { provider: true },
    });
    return new Set(rows.map((r) => r.provider as ChatProvider));
  }

  /** The decrypted credentials of the instance's chat app, or null when it is off. */
  async connection<P extends ChatProvider>(provider: P): Promise<ChatConnection<P> | null> {
    const organizationId = await this.organizationId();
    if (!organizationId) return null;
    const integration = await findSingleIntegration(this.db, organizationId, provider);
    if (!integration) return null;
    const secrets = this.storedSecrets(integration);
    if (SECRET_FIELDS[provider].some((field) => !secrets[field])) return null;
    if (provider === 'TEAMS' && !integration.appId) return null;
    const credentials = (
      provider === 'TEAMS' ? { ...secrets, appId: integration.appId ?? '' } : secrets
    ) as ChatCredentials[P];
    return { organizationId, credentials };
  }
}
