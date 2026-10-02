import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { PrismaClient } from '@vorasaan/db';
import type {
  AtlassianSettingsInput,
  AtlassianSettingsView,
  AtlassianTestResult,
} from '@vorasaan/shared';
import {
  type AtlassianConnection,
  AtlassianError,
  AtlassianNotConnectedError,
  atlassianGet,
  atlassianSite,
  jiraIssueUrl,
} from '../attachments/atlassian.ts';
import { UrlFetchError } from '../attachments/fetch-url.ts';
import { SecretBox } from '../crypto/secret-box.ts';
import { InjectPrisma } from '../prisma/prisma.module.ts';
import { findSingleIntegration, saveSingleIntegration } from './single-integration.ts';

type AtlassianUser = { displayName?: string; publicName?: string };

/**
 * The Organization's Atlassian site, stored as the ATLASSIAN OrgIntegration with
 * the API token encrypted. The token never leaves this service except in the
 * Authorization header of requests to that site.
 */
@Injectable()
export class AtlassianSettingsService {
  private box: SecretBox | undefined;

  constructor(@InjectPrisma() private readonly db: PrismaClient) {}

  /** Lazily, so the server still boots (and says why) without VORASAAN_SECRET_KEY. */
  private secrets(): SecretBox {
    this.box ??= SecretBox.fromEnv();
    return this.box;
  }

  // Self-hosted: one Organization per instance.
  private async organizationId(): Promise<string | undefined> {
    const org = await this.db.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return org?.id;
  }

  private async integration() {
    const organizationId = await this.organizationId();
    if (!organizationId) return null;
    return findSingleIntegration(this.db, organizationId, 'ATLASSIAN');
  }

  async view(): Promise<AtlassianSettingsView> {
    const integration = await this.integration();
    return {
      configured: Boolean(integration),
      siteUrl: integration?.baseUrl ?? null,
      email: integration?.accountEmail ?? null,
      apiTokenSet: Boolean(integration?.secretEncrypted),
    };
  }

  /** The decrypted connection, or null when an Admin hasn't set one up. */
  async connection(): Promise<AtlassianConnection | null> {
    const integration = await this.integration();
    if (!integration?.baseUrl || !integration.accountEmail) return null;
    return {
      siteUrl: integration.baseUrl,
      email: integration.accountEmail,
      apiToken: this.secrets().decrypt(integration.secretEncrypted),
    };
  }

  async requireConnection(): Promise<AtlassianConnection> {
    const connection = await this.connection();
    if (!connection) throw new AtlassianNotConnectedError();
    return connection;
  }

  /** The Jira issue on the site, or null when Atlassian isn't connected. */
  async jiraIssueUrl(key: string | null): Promise<string | null> {
    if (!key) return null;
    const integration = await this.integration();
    if (!integration?.baseUrl) return null;
    try {
      return jiraIssueUrl(atlassianSite(integration.baseUrl), key);
    } catch {
      return null;
    }
  }

  /**
   * Fills in the stored token when the input leaves it out. A stored token is
   * only reused for the same site, so it can never be sent to a new host.
   */
  private async complete(input: AtlassianSettingsInput): Promise<AtlassianConnection> {
    const site = atlassianSite(input.siteUrl);
    let apiToken = input.apiToken;
    if (!apiToken) {
      const existing = await this.integration();
      const sameSite =
        existing?.baseUrl && new URL(existing.baseUrl).origin === site.origin ? existing : null;
      if (!sameSite) {
        throw new AtlassianError(
          existing ? 'Enter the API token again for the new site' : 'Enter an API token',
        );
      }
      apiToken = this.secrets().decrypt(sameSite.secretEncrypted);
    }
    return { siteUrl: site.origin, email: input.email, apiToken };
  }

  async save(input: AtlassianSettingsInput): Promise<AtlassianSettingsView> {
    const organizationId = await this.organizationId();
    if (!organizationId) throw new UnprocessableEntityException('Run setup first');
    let connection: AtlassianConnection;
    try {
      connection = await this.complete(input);
    } catch (error) {
      if (error instanceof AtlassianError) throw new UnprocessableEntityException(error.message);
      throw error;
    }
    const data = {
      baseUrl: connection.siteUrl,
      accountEmail: connection.email,
      secretEncrypted: this.secrets().encrypt(connection.apiToken),
    };
    await saveSingleIntegration(this.db, organizationId, 'ATLASSIAN', data);
    return this.view();
  }

  /** Checks the credentials against the site (Jira, then Confluence), without saving. */
  async test(input: AtlassianSettingsInput): Promise<AtlassianTestResult> {
    try {
      const connection = await this.complete(input);
      const me = await atlassianGet<AtlassianUser>(
        connection,
        '/rest/api/3/myself',
        'The Jira account',
      ).catch((error) =>
        // A site without Jira: try Confluence.
        error instanceof AtlassianError && error.status === 404
          ? atlassianGet<AtlassianUser>(
              connection,
              '/wiki/rest/api/user/current',
              'The Confluence account',
            )
          : Promise.reject(error),
      );
      const name = me.displayName ?? me.publicName ?? connection.email;
      return { ok: true, message: `Connected to ${new URL(connection.siteUrl).host} as ${name}` };
    } catch (error) {
      if (error instanceof AtlassianError) return { ok: false, message: error.message };
      if (error instanceof UrlFetchError) return { ok: false, message: error.message };
      throw error;
    }
  }
}
