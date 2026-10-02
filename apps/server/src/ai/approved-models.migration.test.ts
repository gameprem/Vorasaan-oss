import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { readdir } from 'node:fs/promises';
import { createPrismaClient, type PrismaClient } from '@vorasaan/db';
import pg from 'pg';
import { SecretBox } from '../crypto/secret-box.ts';
import { testDatabaseUrl } from '../test/database.ts';
import { AiSettingsService } from './ai-settings.service.ts';

// An install from before ticket 0053 (one LLM provider, `isDefaultLlm`, its model
// on OrgIntegration) is migrated, then must work unchanged: one provider, its
// model the default Approved Model, and every AI task running on it.

const MIGRATION = '20261001170000_approved_models';
const migrationsDir = new URL('../../../../packages/db/prisma/migrations/', import.meta.url)
  .pathname;

const target = new URL(testDatabaseUrl);
const name = target.pathname.slice(1).replace(/_test$/, '_migration_test');
target.pathname = `/${name}`;
const admin = new URL(testDatabaseUrl);
admin.pathname = '/postgres';

const SECRET = 'migration-test-secret-key';
const ORG = '00000000-0000-4000-8000-0000000000a1';

async function withClient<T>(url: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Whether a Prisma query is refused. */
const fails = (query: PromiseLike<unknown>) =>
  Promise.resolve(query).then(
    () => false,
    () => true,
  );

async function migrationSql(dir: string): Promise<string> {
  return Bun.file(`${migrationsDir}${dir}/migration.sql`).text();
}

describe(`migration ${MIGRATION}`, () => {
  const box = new SecretBox(SECRET);
  let db: PrismaClient;

  beforeAll(async () => {
    if (!name.endsWith('_test')) throw new Error(`Refusing to use "${name}"`);
    await withClient(admin.toString(), async (c) => {
      await c.query(`DROP DATABASE IF EXISTS "${name}"`);
      await c.query(`CREATE DATABASE "${name}"`);
    });
    const dirs = (await readdir(migrationsDir, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    const before = dirs.filter((d) => d < MIGRATION);
    expect(dirs).toContain(MIGRATION);

    await withClient(target.toString(), async (c) => {
      for (const dir of before) await c.query(await migrationSql(dir));
      // The old shape: an Anthropic provider that is the default, and an OpenAI one that isn't.
      await c.query(`INSERT INTO "Organization" ("id", "name") VALUES ($1, 'Acme Bank')`, [ORG]);
      await c.query(
        `INSERT INTO "OrgIntegration" ("id", "organizationId", "provider", "model", "secretEncrypted", "isDefaultLlm", "updatedAt")
         VALUES ('i-anthropic', $1, 'ANTHROPIC', 'claude-opus-5-5', $2, true, now()),
                ('i-openai', $1, 'OPENAI', 'gpt-5.6-sol', $3, false, now())`,
        [ORG, box.encrypt('sk-ant-old-key'), box.encrypt('sk-openai-old')],
      );
      await c.query(
        `INSERT INTO "OrgIntegration" ("id", "organizationId", "provider", "baseUrl", "model", "secretEncrypted", "updatedAt")
         VALUES ('i-embeddings', $1, 'EMBEDDINGS', 'http://localhost:11434/v1', 'nomic-embed-text', $2, now())`,
        [ORG, box.encrypt('emb')],
      );
      await c.query(await migrationSql(MIGRATION));
      // Then every later migration, as an upgrade runs them (0060 backfills the context windows).
      for (const dir of dirs.filter((d) => d > MIGRATION)) await c.query(await migrationSql(dir));
    });
    db = createPrismaClient(target.toString());
    // Creating a database and running every migration takes a while under a full parallel run.
  }, 60_000);

  afterAll(async () => {
    await db?.$disconnect();
    // FORCE ends connections still closing under a parallel run, so the drop doesn't wait on them.
    await withClient(admin.toString(), (c) =>
      c.query(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`),
    );
  }, 60_000);

  test('the default provider is the first provider, and its model the default Approved Model', async () => {
    const models = await db.approvedModel.findMany();
    expect(models).toEqual([
      expect.objectContaining({
        organizationId: ORG,
        integrationId: 'i-anthropic',
        modelId: 'claude-opus-5-5',
        displayName: 'claude-opus-5-5',
        position: 0,
        isDefault: true,
      }),
    ]);
    const providers = await db.orgIntegration.findMany({ orderBy: { id: 'asc' } });
    expect(providers.map((p) => [p.id, p.name, p.model])).toEqual([
      ['i-anthropic', 'Anthropic', null],
      ['i-embeddings', null, 'nomic-embed-text'],
      ['i-openai', 'OpenAI', null],
    ]);
  });

  test('every AI task then runs on the migrated model, with the same key', async () => {
    const previous = process.env.VORASAAN_SECRET_KEY;
    process.env.VORASAAN_SECRET_KEY = SECRET;
    try {
      const service = new AiSettingsService(db, async () => {});
      for (const task of ['generateChoices', 'chat', 'summarizeConversation'] as const) {
        expect(await service.chooseModel(task)).toEqual({
          source: 'APPROVED_MODEL',
          approvedModelId: expect.any(String),
          integrationId: 'i-anthropic',
          provider: {
            provider: 'ANTHROPIC',
            model: 'claude-opus-5-5',
            apiKey: 'sk-ant-old-key',
            baseUrl: null,
          },
          name: 'claude-opus-5-5',
          // Backfilled by the context windows migration (ticket 0060): a known model.
          contextWindow: 1_000_000,
        });
      }
      const view = await service.view();
      expect(view.models.map((m) => [m.displayName, m.providerName, m.isDefault])).toEqual([
        ['claude-opus-5-5', 'Anthropic', true],
      ]);
      expect(view.providers.map((p) => [p.kind, p.apiKeyHint, p.modelCount])).toEqual([
        ['ANTHROPIC', '…-key', 1],
        ['OPENAI', '…-old', 0],
      ]);
    } finally {
      if (previous === undefined) delete process.env.VORASAAN_SECRET_KEY;
      else process.env.VORASAAN_SECRET_KEY = previous;
    }
  });

  test('a second default and a second embeddings integration are refused by the database', async () => {
    const extra = await db.approvedModel.create({
      data: {
        organizationId: ORG,
        integrationId: 'i-openai',
        modelId: 'gpt-5.6-sol',
        displayName: 'GPT',
        contextWindow: 400_000,
        position: 1,
      },
    });
    expect(
      await fails(db.approvedModel.update({ where: { id: extra.id }, data: { isDefault: true } })),
    ).toBe(true);
    expect(
      await fails(
        db.orgIntegration.create({
          data: {
            organizationId: ORG,
            provider: 'EMBEDDINGS',
            baseUrl: 'http://x/v1',
            secretEncrypted: 'v1:x',
          },
        }),
      ),
    ).toBe(true);
  });
});
