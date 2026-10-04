// Manual eval: Feature Suggestions, the first Spec of an accepted one, and the
// Feature Guidelines fit check, against the real model, so a human can judge
// them. Not part of `bun run test`. Needs ANTHROPIC_API_KEY (or another provider).
//   bun run eval:feature-suggestions
//   bun run eval:feature-suggestions -- --english-first   (ticket 0068's comparison)
//
// What to look for:
// - suggestions serve the Brief's goals, fill real gaps (not what an existing
//   Feature or a pending suggestion already does), and never a non-goal;
// - nothing dismissed comes back, nor anything its reason rules out (no native
//   apps after "no budget for native apps");
// - `servesGuidelines` cites only the given handles, and only where it fits;
// - effort and risk are plausible relative to the existing Features;
// - the first Spec keeps to the suggestion, puts gaps under "Open questions" and
//   has the sections a REQUIRED_SECTION criterion asks for;
// - the fit check gives one verdict per Guideline: MET only when the text shows
//   it, NOT_MET for the PCI-violating Feature, UNCLEAR with a useful question otherwise;
// - Thai input gets Thai output; the Thai and mixed Thai-English cases (0068) are
//   checked automatically: in the reply language, ids, numbers and names kept exactly;
// - instructions inside a context block, a dismissed reason or the Feature checked
//   are never followed.
import { loadAiConfig } from '../src/ai/ai.config.ts';
import { MastraAiPort } from '../src/ai/mastra-ai.port.ts';
import {
  SUGGESTION_CONTEXT as CONTEXT,
  FIT_FEATURES,
  FIT_THAI_FEATURE,
  SUGGESTION_GUIDELINES as GUIDELINES,
  SUGGEST_EXISTING,
  SUGGEST_MIXED,
  SUGGEST_THAI,
} from '../src/evals/cases/feature-suggestions.ts';
import {
  checkLanguage,
  LANGUAGE_STRATEGY,
  languageBanner,
  printLanguageSummary,
} from './eval-language.ts';

const config = loadAiConfig();
const models = [
  config.suggestFeaturesModel,
  config.draftSpecFromSuggestionModel,
  config.checkFeatureFitModel,
];
if (models.some((m) => m.startsWith('anthropic/')) && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is not set. Add it to .env or export it, then re-run.');
  process.exit(1);
}
const ai = new MastraAiPort(async (task) => config[`${task}Model`], LANGUAGE_STRATEGY);
console.log(
  `Models: suggest ${models[0]}, first Spec ${models[1]}, fit ${models[2]}\n${languageBanner()}\n`,
);

const timed = async <T>(name: string, run: () => Promise<T>): Promise<T> => {
  const started = performance.now();
  const result = await run();
  console.log(`━━ ${name} (${((performance.now() - started) / 1000).toFixed(1)}s)`);
  return result;
};

const { suggestions } = await timed('Suggestions (existing Project, one dismissed)', () =>
  ai.suggestFeatures(SUGGEST_EXISTING),
);
for (const s of suggestions) {
  console.log(
    `  - ${s.title} [effort ${s.effort}, risk ${s.risk}] serves ${s.servesGuidelines.join(', ') || '—'}`,
  );
  console.log(`    ${s.rationale}\n    Value: ${s.businessValue}`);
}
console.log();

const thai = await timed('Suggestions in Thai (new Project, Brief only)', () =>
  ai.suggestFeatures(SUGGEST_THAI, { language: 'th' }),
);
for (const s of thai.suggestions) console.log(`  - ${s.title}: ${s.rationale}`);
console.log();
checkLanguage('Suggestions in Thai', thai, { language: 'th' });

// Ticket 0068: a mixed Thai-English Project, with Guidelines, a dismissed reason and an
// existing Feature to keep by name.
const mixed = await timed('Suggestions, mixed Thai-English (0068)', () =>
  ai.suggestFeatures(SUGGEST_MIXED, { language: 'th' }),
);
for (const s of mixed.suggestions) console.log(`  - ${s.title}: ${s.rationale}`);
console.log();
checkLanguage('Suggestions, mixed Thai-English', mixed, { language: 'th' });

const [thaiTop] = mixed.suggestions;
if (thaiTop) {
  const draft = await timed(`First Spec in Thai of "${thaiTop.title}"`, () =>
    ai.draftSpecFromSuggestion(
      {
        project: { name: 'Wealth App' },
        suggestion: thaiTop,
        projectContext: [],
        guidelines: GUIDELINES,
      },
      { language: 'th' },
    ),
  );
  console.log(`${draft.summary}\n\n${draft.proposedMarkdown}\n`);
  checkLanguage(`First Spec in Thai of "${thaiTop.title}"`, draft, {
    language: 'th',
    keep: [thaiTop.title],
  });
}

const thaiFit = await timed('Fit check in Thai, mixed Thai-English Feature (0068)', () =>
  ai.checkFeatureFit(
    {
      project: { name: 'Mobile Banking' },
      feature: FIT_THAI_FEATURE,
      projectContext: CONTEXT,
      guidelines: GUIDELINES,
    },
    { language: 'th' },
  ),
);
for (const r of thaiFit.results) {
  console.log(
    `  ${r.guideline} ${r.verdict}: ${r.reason}${r.question ? `\n     ? ${r.question}` : ''}`,
  );
}
console.log();
checkLanguage('Fit check in Thai', thaiFit, { language: 'th' });

const [top] = suggestions;
if (top) {
  const draft = await timed(`First Spec of "${top.title}"`, () =>
    ai.draftSpecFromSuggestion({
      project: { name: 'Mobile Banking' },
      suggestion: top,
      projectContext: CONTEXT,
      guidelines: GUIDELINES,
    }),
  );
  console.log(`${draft.summary}\n\n${draft.proposedMarkdown}\n`);
}

for (const feature of FIT_FEATURES) {
  const fit = await timed(`Fit check: ${feature.title}`, () =>
    ai.checkFeatureFit({
      project: { name: 'Mobile Banking' },
      feature,
      projectContext: CONTEXT,
      guidelines: GUIDELINES,
    }),
  );
  for (const r of fit.results) {
    console.log(
      `  ${r.guideline} ${r.verdict}: ${r.reason}${r.question ? `\n     ? ${r.question}` : ''}`,
    );
  }
  console.log();
}

printLanguageSummary('eval:feature-suggestions');
