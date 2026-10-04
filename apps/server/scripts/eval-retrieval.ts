// Manual eval: retrieval on a large multi-document Project where the answer sits in
// one paragraph of one long Attachment (ADR 0007). Not part of `bun run test`.
// Needs the dev database (DATABASE_URL, migrated) and the AI provider configured in
// Settings (or ANTHROPIC_API_KEY); uses the embeddings provider when one is set,
// the keyword fallback otherwise.
//   bun run eval:retrieval
// (It uses the server's own AI port, so it has no --english-first mode; its Thai case
// (0068) checks retrieval and the reply language only.)
//
// It creates a temporary Project in the first Organization, indexes it, and deletes
// it at the end. What to look for:
// - the needle paragraph is retrieved, early, with or without embeddings;
// - the context stays within the budget and nothing comes from another Project;
// - the Choices use the exact facts (22:30, 12 THB) and don't invent others;
// - the Spec draft cites the handbook by its id in its summary.
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { PrismaClient } from '@vorasaan/db';
import { SEED_SPEC_V1 } from '@vorasaan/db/seed';
import { AI_PORT, type AiPort } from '../src/ai/ai.port.ts';
import { CONTEXT_CEILINGS } from '../src/ai/context-budget.ts';
import { AppModule } from '../src/app.module.ts';
import { AttachmentFilesService } from '../src/attachments/attachment-files.service.ts';
import { PRISMA } from '../src/prisma/prisma.module.ts';
import {
  blockTokens,
  ContextRetriever,
  splitFeatureSpec,
} from '../src/retrieval/context-retriever.ts';
import { EmbeddingSettingsService } from '../src/retrieval/embedding-settings.service.ts';
import { IndexingService } from '../src/retrieval/indexing.service.ts';
import {
  FEATURE_ATTACHMENTS,
  NEEDLE_FACTS,
  NEEDLE_PARAGRAPH,
  NEEDLE_QUESTION,
  OTHER_FEATURES,
} from '../src/retrieval/large-project.fixture.ts';
import { checkLanguage, printLanguageSummary } from './eval-language.ts';

const app = await NestFactory.createApplicationContext(AppModule, { logger: ['warn', 'error'] });
const db = app.get<PrismaClient>(PRISMA);
const retriever = app.get(ContextRetriever);
const indexing = app.get(IndexingService);
const ai = app.get<AiPort>(AI_PORT);

const membership = await db.orgMembership.findFirst({ orderBy: { createdAt: 'asc' } });
if (!membership) {
  console.error('No Organization yet: run `bun run db:seed` or sign up first.');
  process.exit(1);
}
const embeddingsModel = await app.get(EmbeddingSettingsService).model(membership.organizationId);
console.log(
  `Ranking: ${embeddingsModel ? `embeddings (${embeddingsModel})` : 'keyword fallback'}\n`,
);

const project = await db.project.create({
  data: {
    organizationId: membership.organizationId,
    name: `Eval: retrieval ${new Date().toISOString()}`,
  },
});
try {
  const team = await db.team.create({ data: { projectId: project.id, name: 'Payments' } });
  const feature = await db.feature.create({
    data: {
      teamId: team.id,
      title: 'Async checkout',
      description: 'Let customers finish checkout without waiting for the payment provider.',
    },
  });
  await db.specVersion.create({
    data: {
      featureId: feature.id,
      version: 1,
      markdown: SEED_SPEC_V1,
      source: 'MANUAL',
      approvedById: membership.userId,
    },
  });
  for (const doc of FEATURE_ATTACHMENTS) {
    const attachment = await db.attachment.create({
      data: {
        featureId: feature.id,
        source: 'FILE',
        title: doc.title,
        snapshotText: doc.text,
        snapshotAt: new Date(),
        addedById: membership.userId,
      },
    });
    await indexing.index({ source: 'ATTACHMENT', id: attachment.id });
  }
  for (const other of OTHER_FEATURES) {
    const f = await db.feature.create({ data: { teamId: team.id, title: other.title } });
    const version = await db.specVersion.create({
      data: {
        featureId: f.id,
        version: 1,
        markdown: other.spec,
        source: 'MANUAL',
        approvedById: membership.userId,
      },
    });
    await indexing.index({ source: 'SPEC_VERSION', id: version.id });
  }

  // Case 1: Choices for a question whose answer is one paragraph of the handbook.
  const query = `${NEEDLE_QUESTION.title}\n\n${NEEDLE_QUESTION.description}`;
  const blocks = await retriever.forFeature(feature.id, query, CONTEXT_CEILINGS.decisionRequest);
  const used = blocks.reduce((n, b) => n + blockTokens(b), 0);
  const needleAt = blocks.findIndex((b) => b.text.includes(NEEDLE_PARAGRAPH));
  console.log(`━━ Choices: "${NEEDLE_QUESTION.title}"`);
  console.log(`   ${blocks.length} blocks, ${used}/${CONTEXT_CEILINGS.decisionRequest} tokens`);
  for (const [i, b] of blocks.entries()) {
    console.log(`   ${i + 1}. [${b.scope}] ${b.source.kind} ${b.source.title} (${b.source.id})`);
  }
  console.log(`   needle: ${needleAt === -1 ? 'MISSING' : `block ${needleAt + 1}`}`);
  const { spec, context } = splitFeatureSpec(blocks);
  let started = performance.now();
  const choices = await ai.generateChoices({
    specMarkdown: spec?.text ?? '',
    context,
    request: { kind: 'QUESTION', raiserRole: 'BACKEND', ...NEEDLE_QUESTION },
  });
  const answer = JSON.stringify(choices);
  console.log(`   (${((performance.now() - started) / 1000).toFixed(1)}s)`);
  for (const c of choices.choices)
    console.log(`\n   ${c.label}. ${c.title}\n      ${c.description}`);
  console.log(
    `\n   facts used: ${NEEDLE_FACTS.map((f) => `${f} ${answer.includes(f) ? 'yes' : 'NO'}`).join(', ')}\n`,
  );

  // Case 1b (ticket 0068): the same question in mixed Thai-English. The needle is still
  // retrieved, and the Choices are in Thai with the facts kept exactly.
  const thaiQuestion = {
    title: 'PromptPay settlement cutoff กี่โมง',
    description:
      'batch ของ payout scheduler ไปถึงธนาคารช้าบ้าง ควรตั้ง cutoff เท่าไหร่ และ batch ที่ช้าเสียค่าอะไร',
  };
  const thaiBlocks = await retriever.forFeature(
    feature.id,
    `${thaiQuestion.title}\n\n${thaiQuestion.description}`,
    CONTEXT_CEILINGS.decisionRequest,
  );
  const thaiNeedleAt = thaiBlocks.findIndex((b) => b.text.includes(NEEDLE_PARAGRAPH));
  console.log(`━━ Choices, mixed Thai-English: "${thaiQuestion.title}"`);
  console.log(`   needle: ${thaiNeedleAt === -1 ? 'MISSING' : `block ${thaiNeedleAt + 1}`}`);
  const thaiSplit = splitFeatureSpec(thaiBlocks);
  started = performance.now();
  const thaiChoices = await ai.generateChoices(
    {
      specMarkdown: thaiSplit.spec?.text ?? '',
      context: thaiSplit.context,
      request: { kind: 'QUESTION', raiserRole: 'BACKEND', ...thaiQuestion },
    },
    { language: 'th' },
  );
  console.log(`   (${((performance.now() - started) / 1000).toFixed(1)}s)`);
  for (const c of thaiChoices.choices)
    console.log(`\n   ${c.label}. ${c.title}\n      ${c.description}`);
  console.log();
  checkLanguage('Choices, mixed Thai-English', thaiChoices, {
    language: 'th',
    keep: [...NEEDLE_FACTS, 'PromptPay'],
  });

  // Case 2: a Spec drafted from the same large Attachments.
  const draftBlocks = await retriever.forFeature(
    feature.id,
    `${feature.title}\n\n${feature.description}`,
    CONTEXT_CEILINGS.specFromAttachments,
  );
  started = performance.now();
  const draft = await ai.draftSpecFromAttachments({
    feature: { title: feature.title, description: feature.description ?? '' },
    specMarkdown: SEED_SPEC_V1,
    context: splitFeatureSpec(draftBlocks).context,
  });
  console.log(
    `━━ Spec from Attachments: ${draftBlocks.length} blocks ` +
      `(${((performance.now() - started) / 1000).toFixed(1)}s)\n   ${draft.summary}\n\n${draft.proposedMarkdown}\n`,
  );
  printLanguageSummary('eval:retrieval');
} finally {
  await app.get(AttachmentFilesService).deleteProject(project.id);
  await app.close();
}
