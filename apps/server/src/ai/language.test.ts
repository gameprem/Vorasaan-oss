import { describe, expect, test } from 'bun:test';
import type { ChoiceDraft } from '@vorasaan/shared';
import { loadPartial } from '@vorasaan/skills';
import type { AiTask } from './ai.config.ts';
import type { ContextBlock, RedraftFeedbackForAi, RequestForAi } from './ai.port.ts';
import { LANGUAGE_NAME, languageValues, type PromptLanguage } from './language.ts';
import type { Prompt } from './prompt-cache.ts';
import * as prompts from './prompts.ts';
import { TASK_SKILLS } from './prompts.ts';
import { emptyMemory } from './workflow-memory.ts';

// Ticket 0068: every prompt carries the one language rules block, in the reply
// language of the call, and keeps what people wrote (Thai included) as written.

/** People's own words, in Thai and mixed Thai-English, with a quote, an id and numbers. */
const QUOTE = 'ลูกค้าบอกว่า "จ่ายแล้วแต่ยังขึ้นว่ารอชำระ" ตั้งแต่ DR-12 เกิน 24 ชม.';
const MIXED = 'ปุ่ม Retry ใน order card ต้องรอ PayFast webhook ไม่เกิน 5 วินาที';

const request: RequestForAi = {
  kind: 'BLOCKER',
  raiserRole: 'FRONTEND',
  title: 'ปุ่ม Retry ควรอยู่ตรงไหน',
  description: QUOTE,
};
const context: ContextBlock[] = [
  { source: { kind: 'DECISION', id: 'd-7', title: 'การตัดสินใจ' }, scope: 'FEATURE', text: MIXED },
];
const foundation = { brief: { version: 1, markdown: MIXED }, guidelines: [] };
const project = { name: 'แอปธนาคาร' };
const feature = { title: 'Checkout v2', description: MIXED };
const suggestion = {
  title: 'แจ้งเตือนการชำระเงิน',
  rationale: QUOTE,
  businessValue: MIXED,
  effort: 'LOW' as const,
  risk: 'LOW' as const,
};
const choices: ChoiceDraft[] = [
  {
    label: 'A',
    title: 'ใส่ปุ่ม Retry',
    description: MIXED,
    impactScope: 'Spec',
    impactTime: '+1 วัน',
    impactRisk: 'ต่ำ',
  },
];
const feedback: RedraftFeedbackForAi = {
  current: 1,
  feedback: { redraft: 1, feedback: QUOTE, pointer: null },
  earlier: [],
};

/** Every AI task's prompt, built with `lang`: a Record, so a new task must be added here. */
const promptForAi = { name: 'generate-choices' as const, tasks: ['generateChoices'] };
const patterns = [
  { title: 'Often asked to be shorter', description: MIXED, count: 3, examples: [QUOTE] },
];

const BUILDERS: Record<AiTask, (lang: PromptLanguage) => Promise<Prompt>> = {
  generateChoices: (lang) =>
    prompts.generateChoicesPrompt(MIXED, request, context, foundation, lang),
  draftSpecProposal: (lang) =>
    prompts.draftSpecProposalPrompt(
      MIXED,
      request,
      { kind: 'custom', answer: QUOTE },
      context,
      foundation,
      lang,
    ),
  summarizeAttachment: (lang) =>
    prompts.summarizeAttachmentPrompt({ title: 'บันทึก', source: 'FILE', text: QUOTE }, lang),
  draftSpecFromAttachments: (lang) =>
    prompts.draftSpecFromAttachmentsPrompt(feature, MIXED, context, lang),
  grillingQuestions: (lang) =>
    prompts.grillingQuestionsPrompt(
      {
        project,
        round: 'BUSINESS',
        role: 'PO',
        projectContext: context,
        guidelines: [],
        memory: emptyMemory(),
      },
      lang,
    ),
  grillingFollowUp: (lang) =>
    prompts.grillingFollowUpPrompt(
      {
        project,
        round: 'BUSINESS',
        role: 'PO',
        question: 'กลุ่มผู้ใช้เป้าหมายคือใคร',
        answer: QUOTE,
        followUps: [],
        remaining: 2,
      },
      lang,
    ),
  draftBriefFromGrilling: (lang) =>
    prompts.draftBriefFromGrillingPrompt(
      {
        project,
        briefMarkdown: MIXED,
        projectContext: context,
        guidelines: [],
        memory: emptyMemory(),
        answers: [
          {
            round: 'BUSINESS',
            question: 'เป้าหมายคืออะไร',
            answer: QUOTE,
            answeredBy: { name: 'สมชาย', role: 'PO' },
            followUps: [],
          },
        ],
      },
      lang,
    ),
  suggestFeatures: (lang) =>
    prompts.suggestFeaturesPrompt(
      {
        project,
        count: 3,
        projectContext: context,
        guidelines: [],
        decisions: context,
        dismissed: [{ title: 'ไม่เอา', rationale: MIXED, reason: QUOTE }],
        pending: [],
      },
      lang,
    ),
  draftSpecFromSuggestion: (lang) =>
    prompts.draftSpecFromSuggestionPrompt(
      { project, suggestion, projectContext: context, guidelines: [] },
      lang,
    ),
  checkFeatureFit: (lang) =>
    prompts.checkFeatureFitPrompt(
      {
        project,
        feature: { title: 'Checkout v2', description: QUOTE },
        projectContext: [],
        guidelines: [],
      },
      lang,
    ),
  chat: (lang) =>
    prompts.chatPrompt(
      {
        scope: { kind: 'FEATURE', project, feature },
        context,
        foundation,
        summary: QUOTE,
      },
      lang,
    ),
  summarizeConversation: (lang) =>
    prompts.summarizeConversationPrompt(
      {
        scope: { kind: 'PROJECT', project },
        summary: '',
        messages: [{ role: 'USER', content: QUOTE }],
        actionCards: [],
      },
      lang,
    ),
  redraftChoices: (lang) =>
    prompts.redraftChoicesPrompt(
      { ...feedback, specMarkdown: MIXED, request, choices, context, foundation },
      lang,
    ),
  redraftSpecProposal: (lang) =>
    prompts.redraftSpecProposalPrompt(
      { ...feedback, feature, specMarkdown: MIXED, proposedMarkdown: MIXED, context, foundation },
      lang,
    ),
  redraftBriefProposal: (lang) =>
    prompts.redraftBriefProposalPrompt(
      {
        ...feedback,
        project,
        briefMarkdown: MIXED,
        proposedMarkdown: MIXED,
        projectContext: context,
        guidelines: [],
      },
      lang,
    ),
  redraftFeatureSuggestion: (lang) =>
    prompts.redraftFeatureSuggestionPrompt(
      { ...feedback, project, suggestion, projectContext: context, guidelines: [] },
      lang,
    ),
  analyzeFeedback: (lang) =>
    prompts.analyzeFeedbackPrompt(
      {
        prompt: promptForAi,
        template: MIXED,
        calls: 4,
        cases: [
          {
            index: 1,
            outcome: 'REQUEST_CHANGES',
            proposal: 'CHOICES',
            redraft: 1,
            text: QUOTE,
            redraftsBeforeApproval: null,
            choiceLabel: null,
            editSize: null,
          },
        ],
      },
      lang,
    ),
  proposePromptVersion: (lang) =>
    prompts.proposePromptVersionPrompt(
      { prompt: promptForAi, template: MIXED, placeholders: ['spec'], patterns },
      lang,
    ),
  redraftPromptVersion: (lang) =>
    prompts.redraftPromptVersionPrompt(
      {
        ...feedback,
        prompt: promptForAi,
        template: MIXED,
        rationale: QUOTE,
        active: MIXED,
        placeholders: ['spec'],
        patterns,
      },
      lang,
    ),
};

const TASKS = Object.keys(TASK_SKILLS) as AiTask[];

/** The language rules block as a prompt renders it for `lang`. */
async function rulesFor(lang: PromptLanguage): Promise<string> {
  const values = languageValues(lang);
  return (await loadPartial('language'))
    .replace('{{replyLanguage}}', values.replyLanguage)
    .replace('{{languageStrategy}}', values.languageStrategy);
}

describe('the language rules in every prompt (0068)', () => {
  test('every AI task has a prompt here', () => {
    expect(Object.keys(BUILDERS).sort()).toEqual([...TASKS].sort());
  });

  for (const task of TASKS) {
    test(`${task}: carries the rules once, in the reply language asked for`, async () => {
      const build = BUILDERS[task];
      const english = (await build({})).text;
      expect(english).toContain(await rulesFor({}));
      expect(english).toContain(`The reply language of this task is **${LANGUAGE_NAME.en}**`);
      expect(english.match(/^## Language$/gm)).toHaveLength(1);

      const thai = (await build({ language: 'th' })).text;
      expect(thai).toContain(await rulesFor({ language: 'th' }));
      expect(thai).toContain(`The reply language of this task is **${LANGUAGE_NAME.th}**`);
      expect(thai).toContain('Never translate inside quotation marks');
      expect(thai).toContain('Do not translate the material into English first');
    });

    test(`${task}: keeps people's Thai words, quotes and ids exactly as written`, async () => {
      const text = (await BUILDERS[task]({ language: 'th' })).text;
      const kept = [QUOTE, MIXED].filter((words) => text.includes(words));
      expect(kept.length, `${task} carries neither sample verbatim`).toBeGreaterThan(0);
    });
  }

  test('the comparison variant asks to work in English first, and only it does', async () => {
    const variant = (await BUILDERS.chat({ language: 'th', strategy: 'english-first' })).text;
    expect(variant).toContain('Work the task out in English first');
    expect(variant).not.toContain('Do not translate the material into English first');
    expect(variant).toContain(await rulesFor({ language: 'th', strategy: 'english-first' }));
  });

  test('the rules sit in the stable prefix, the same for every call in one language', async () => {
    const first = await BUILDERS.generateChoices({ language: 'th' });
    const prefix = first.parts[0] ?? '';
    expect(prefix).toContain('## Language');
    const other = await prompts.generateChoicesPrompt(
      'another Spec',
      { ...request, description: 'other words' },
      [],
      foundation,
      { language: 'th' },
    );
    expect(other.parts[0]).toBe(prefix);
  });
});
