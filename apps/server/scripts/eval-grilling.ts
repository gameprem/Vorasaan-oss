// Manual eval: asks Grilling questions and drafts a Project Brief from answers
// against the real model, so a human can judge them. Not part of `bun run test`.
// Needs ANTHROPIC_API_KEY (or another configured provider).
//   bun run eval:grilling
//   bun run eval:grilling -- --english-first   (ticket 0068's comparison)
//
// What to look for:
// - a new Project gets 3–7 specific questions per round, on that round's topic only;
// - an existing Project whose material already answers most of a round gets fewer
//   questions (or none), never questions the context clearly answers;
// - later rounds don't repeat what earlier rounds (the memory) already answered;
// - questions and the Brief are in the people's language (the Thai sample);
// - the Brief uses only facts from the answers and context, keeps exact numbers,
//   and lists gaps and skipped rounds under "Open questions";
// - instructions inside an answer or a context block are never followed;
// - follow-ups (Grilling Conversations, 0044): a vague or number-less answer gets one
//   short, specific follow-up in the person's language; a specific answer, or "we
//   haven't decided", gets null; a follow-up is never repeated; an instruction in
//   the answer ("don't ask follow-ups") is ignored;
// - the Brief keeps who said what (by name and Team Role) where answers disagree,
//   and uses the follow-up replies' numbers;
// - the Thai and mixed Thai-English cases (0068) are checked automatically: in the
//   reply language, with names, ids, numbers and quoted words kept exactly.
import { loadAiConfig } from '../src/ai/ai.config.ts';
import { MastraAiPort } from '../src/ai/mastra-ai.port.ts';
import { emptyMemory } from '../src/ai/workflow-memory.ts';
import {
  ANSWERS,
  BRIEF_SAMPLES,
  briefMemory,
  FOLLOW_UP_SAMPLES as followUpSamples,
  GRILLING_GUIDELINES as GUIDELINES,
  QUESTION_SAMPLES as questionSamples,
  THAI_ANSWERS,
  THAI_BRIEF,
} from '../src/evals/cases/grilling.ts';
import {
  checkLanguage,
  LANGUAGE_STRATEGY,
  languageBanner,
  printLanguageSummary,
} from './eval-language.ts';

const config = loadAiConfig();
const models = [
  config.grillingQuestionsModel,
  config.draftBriefFromGrillingModel,
  config.grillingFollowUpModel,
];
if (models.some((m) => m.startsWith('anthropic/')) && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Add it to .env or export it, then re-run.');
  process.exit(1);
}
const ai = new MastraAiPort(async (task) => config[`${task}Model`], LANGUAGE_STRATEGY);
console.log(
  `Models: questions ${models[0]}, Brief draft ${models[1]}, follow-ups ${models[2]}\n${languageBanner()}\n`,
);

for (const sample of questionSamples) {
  const started = performance.now();
  const { questions } = await ai.grillingQuestions(
    {
      project: { name: sample.project },
      round: sample.round,
      role: sample.role,
      projectContext: sample.context,
      guidelines: GUIDELINES,
      memory: sample.memory,
    },
    { language: sample.lang?.language },
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`━━ ${sample.name} (${seconds}s): ${questions.length} questions`);
  for (const q of questions) console.log(`  - ${q}`);
  console.log();
  if (sample.lang) checkLanguage(`Questions: ${sample.name}`, questions, sample.lang);
}

for (const sample of followUpSamples) {
  const started = performance.now();
  const { followUp } = await ai.grillingFollowUp(
    {
      project: { name: 'Mobile Banking' },
      round: sample.round,
      role: sample.role,
      question: sample.question,
      answer: sample.answer,
      followUps: sample.followUps,
      remaining: 2 - sample.followUps.length,
    },
    { language: sample.lang?.language },
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`━━ Follow-up: ${sample.name} (${seconds}s), expect ${sample.expect}`);
  console.log(`  → ${followUp ?? 'null'}\n`);
  if (sample.lang && followUp) checkLanguage(`Follow-up: ${sample.name}`, followUp, sample.lang);
}

const memory = briefMemory();
for (const { name, briefMarkdown, context } of BRIEF_SAMPLES.slice(0, 2)) {
  const started = performance.now();
  const draft = await ai.draftBriefFromGrilling({
    project: { name: 'Mobile Banking' },
    briefMarkdown,
    projectContext: [...context],
    guidelines: GUIDELINES,
    memory,
    answers: ANSWERS,
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(`━━ ${name} (${seconds}s): ${draft.summary}\n\n${draft.proposedMarkdown}\n`);
}

// Ticket 0068: a Brief drafted from Thai and mixed Thai-English answers, in Thai, with
// people's names, numbers, ids and a disagreement kept as written.
{
  const started = performance.now();
  const draft = await ai.draftBriefFromGrilling(
    {
      project: { name: 'แอปธนาคารบนมือถือ' },
      briefMarkdown: BRIEF_SAMPLES[2]?.briefMarkdown ?? '',
      projectContext: [],
      guidelines: GUIDELINES,
      memory: emptyMemory(),
      answers: THAI_ANSWERS,
    },
    { language: 'th' },
  );
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `━━ Brief draft from Thai answers (${seconds}s): ${draft.summary}\n\n${draft.proposedMarkdown}\n`,
  );
  checkLanguage('Brief draft from Thai answers', draft, THAI_BRIEF);
}

printLanguageSummary('eval:grilling');
