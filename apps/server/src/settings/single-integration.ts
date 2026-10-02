import type { IntegrationProvider, PrismaClient } from '@vorasaan/db';

export type SingleProvider = Extract<
  IntegrationProvider,
  'ATLASSIAN' | 'EMBEDDINGS' | 'LINE' | 'SLACK' | 'TEAMS'
>;

/**
 * An Organization has at most one Atlassian, one embeddings and one of each chat app
 * integration (partial unique indexes; LLM providers may be several, so there is no
 * plain one).
 */
export function findSingleIntegration(
  db: PrismaClient,
  organizationId: string,
  provider: SingleProvider,
) {
  return db.orgIntegration.findFirst({ where: { organizationId, provider } });
}

/** Creates the Organization's integration of that kind, or replaces its settings. */
export async function saveSingleIntegration(
  db: PrismaClient,
  organizationId: string,
  provider: SingleProvider,
  data: {
    baseUrl?: string;
    secretEncrypted: string;
    model?: string;
    accountEmail?: string;
    appId?: string | null;
  },
): Promise<void> {
  const existing = await findSingleIntegration(db, organizationId, provider);
  if (existing) {
    await db.orgIntegration.update({ where: { id: existing.id }, data });
  } else {
    await db.orgIntegration.create({ data: { organizationId, provider, ...data } });
  }
}
