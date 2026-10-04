// Manual eval: summarizes sample Attachments and drafts a Spec from them against the
// real model, so a human can judge the summaries and drafts. Not part of
// `bun run test`. Needs ANTHROPIC_API_KEY (or another configured provider).
//   bun run eval:spec-from-attachments
//   bun run eval:spec-from-attachments -- --english-first   (ticket 0068's comparison)
//
// What to look for:
// - summaries keep exact numbers and names, in the Attachment's language;
// - the draft uses only facts from the Attachments and lists gaps as open questions;
// - with a current Spec, the draft keeps it and turns contradictions into open questions;
// - instructions inside an Attachment are never followed (the injection sample);
// - the Thai and mixed Thai-English samples (0068) are checked automatically: the
//   draft in the reply language, ids, numbers and quoted words kept exactly.
import { loadAiConfig } from '../src/ai/ai.config.ts';
import { MastraAiPort } from '../src/ai/mastra-ai.port.ts';
import {
  asContext,
  SPEC_FROM_ATTACHMENTS_SAMPLES as samples,
} from '../src/evals/cases/spec-from-attachments.ts';
import {
  checkLanguage,
  LANGUAGE_STRATEGY,
  languageBanner,
  printLanguageSummary,
} from './eval-language.ts';

const config = loadAiConfig();
const models = [config.summarizeAttachmentModel, config.draftSpecFromAttachmentsModel];
if (models.some((m) => m.startsWith('anthropic/')) && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Add it to .env or export it, then re-run.');
  process.exit(1);
}
const ai = new MastraAiPort(async (task) => config[`${task}Model`], LANGUAGE_STRATEGY);
console.log(`Models: summarize ${models[0]}, draft ${models[1]}\n${languageBanner()}\n`);

for (const sample of samples) {
  console.log(`━━ ${sample.name}`);
  for (const attachment of sample.attachments) {
    const started = performance.now();
    const { summary } = await ai.summarizeAttachment(
      { attachment },
      { language: sample.lang?.language },
    );
    const seconds = ((performance.now() - started) / 1000).toFixed(1);
    console.log(`\n── Summary of "${attachment.title}" (${seconds}s)\n${summary}`);
    if (sample.lang) {
      checkLanguage(`${sample.name}: summary of "${attachment.title}"`, summary, {
        language: sample.lang.language,
        keep: sample.lang.keep?.filter((k) => attachment.text.includes(k)),
      });
    }
  }
  const started = performance.now();
  const draft = await ai.draftSpecFromAttachments(
    {
      feature: sample.feature,
      specMarkdown: sample.specMarkdown,
      context: asContext(sample.attachments),
    },
    { language: sample.lang?.language },
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`\n── Draft (${seconds}s): ${draft.summary}\n\n${draft.proposedMarkdown}\n\n`);
  if (sample.lang) checkLanguage(`${sample.name}: draft`, draft, sample.lang);
}

printLanguageSummary('eval:spec-from-attachments');
