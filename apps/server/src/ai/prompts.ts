import type { GrillingRoundKind, TeamRole } from '@vorasaan/shared';
import { renderSkill } from '@vorasaan/skills';
import type {
  AttachmentForAi,
  ContextBlock,
  DecisionForAi,
  FeatureForAi,
  GrillingAnswerForAi,
  GuidelineForAi,
  ProjectForAi,
  RequestForAi,
} from './ai.port.ts';
import { renderMemory, type WorkflowMemory } from './workflow-memory.ts';

const KIND_MEANING = {
  BLOCKER: "the Raiser's work is stopped until this is decided",
  QUESTION: 'the Raiser can keep working meanwhile',
} as const;

/**
 * Neutralises anything in untrusted text that could open or close one of the
 * prompt's data blocks (<attachment>, <context>, <spec>, <brief>, <guidelines>,
 * <memory>, <answers>, <answer>), so retrieved content can't escape its fence in
 * the prompt.
 */
export function fence(text: string): string {
  return text.replace(
    /<(\s*\/?\s*(?:attachment|context|spec|brief|guidelines|memory|answers?)\b)/gi,
    '‹$1',
  );
}

/** An untrusted value made safe for a double-quoted attribute on one line. */
function attribute(text: string): string {
  return fence(text)
    .replace(/["\r\n]+/g, ' ')
    .trim();
}

/** Attachments as fenced, numbered data blocks. Titles are untrusted too. */
export function renderAttachments(attachments: AttachmentForAi[]): string {
  if (attachments.length === 0) return '(No Attachments.)';
  return attachments
    .map(
      (a, i) =>
        `<attachment index="${i + 1}" source="${a.source}" title="${attribute(a.title)}">\n${fence(a.text)}\n</attachment>`,
    )
    .join('\n\n');
}

/**
 * Retrieved context (ADR 0007) as fenced, numbered data blocks. Each carries its
 * source's kind and id, so the output can cite it, and says whether it belongs to
 * this Feature or to another part of the Project. Every text is untrusted.
 */
export function renderContext(
  blocks: ContextBlock[],
  /** For Project-level tasks (Grilling), where there is no Feature to be "elsewhere" from. */
  options: { projectLevel?: boolean } = {},
): string {
  if (blocks.length === 0) return '(No context found.)';
  return blocks
    .map((b, i) => {
      const version = b.source.version === undefined ? '' : ` version="${b.source.version}"`;
      const from = options.projectLevel
        ? 'this Project'
        : b.scope === 'FEATURE'
          ? 'this Feature'
          : 'elsewhere in the Project';
      return (
        `<context index="${i + 1}" kind="${b.source.kind}" id="${attribute(b.source.id)}"${version} ` +
        `from="${from}" title="${attribute(b.source.title)}">\n${fence(b.text)}\n</context>`
      );
    })
    .join('\n\n');
}

export function generateChoicesPrompt(
  specMarkdown: string,
  request: RequestForAi,
  context: ContextBlock[],
) {
  return renderSkill('generate-choices', {
    spec: fence(specMarkdown),
    context: renderContext(context),
    kind: request.kind,
    kindMeaning: KIND_MEANING[request.kind],
    raiserRole: request.raiserRole,
    title: request.title,
    description: request.description,
  });
}

export function describeDecision(decision: DecisionForAi): string {
  const main =
    decision.kind === 'choice'
      ? [
          `Picked Choice ${decision.choice.label}: ${decision.choice.title}`,
          decision.choice.description,
          `Scope: ${decision.choice.impactScope}`,
        ].join('\n')
      : `Answered in their own words: ${decision.answer}`;
  return decision.rationale ? `${main}\nRationale: ${decision.rationale}` : main;
}

export function draftSpecProposalPrompt(
  specMarkdown: string,
  request: RequestForAi,
  decision: DecisionForAi,
  context: ContextBlock[],
) {
  return renderSkill('draft-spec-proposal', {
    spec: fence(specMarkdown),
    context: renderContext(context),
    kind: request.kind,
    title: request.title,
    description: request.description,
    decision: describeDecision(decision),
  });
}

export function summarizeAttachmentPrompt(attachment: AttachmentForAi) {
  return renderSkill('summarize-attachment', {
    attachments: renderAttachments([attachment]),
  });
}

export function draftSpecFromAttachmentsPrompt(
  feature: FeatureForAi,
  specMarkdown: string,
  context: ContextBlock[],
) {
  return renderSkill('draft-spec-from-attachments', {
    featureTitle: feature.title,
    featureDescription: feature.description || '(No description.)',
    spec: fence(specMarkdown) || '(No Spec yet: this will be the first version.)',
    context: renderContext(context),
  });
}

/** What each Grilling round asks about (REQUIREMENT §3.8). */
const ROUND_FOCUS: Record<GrillingRoundKind, string> = {
  BUSINESS:
    'The business: the goals and KPIs the Project serves, its target users and markets, ' +
    'business constraints (legal, budget, deadlines), and what it deliberately does not do.',
  UX:
    'The user experience: who uses the product and in which situations, their main journeys, ' +
    'platforms and devices, accessibility and localisation, design system and tone.',
  TECHNICAL:
    'The technology: architecture and main systems, integrations and data sources, ' +
    'non-functional requirements (performance, security, availability), technical constraints and debt.',
};

/** The effective Feature Guidelines as numbered lines. Human-written, but fenced like any data. */
export function renderGuidelines(guidelines: GuidelineForAi[]): string {
  if (guidelines.length === 0) return '(No Feature Guidelines.)';
  return guidelines
    .map((g, i) => {
      const required = g.required ? 'required' : 'optional';
      const description = g.description ? `: ${g.description}` : '';
      return fence(`${i + 1}. [${g.kind}, ${required}] ${g.title}${description}`);
    })
    .join('\n');
}

/** Every answered question as a fenced block; the answers are people's own words. */
export function renderGrillingAnswers(answers: GrillingAnswerForAi[]): string {
  if (answers.length === 0) return '(No answers.)';
  return answers
    .map(
      (a, i) =>
        `<answer index="${i + 1}" round="${a.round}" question="${attribute(a.question)}">\n${fence(a.answer)}\n</answer>`,
    )
    .join('\n\n');
}

export function grillingQuestionsPrompt(input: {
  project: ProjectForAi;
  round: GrillingRoundKind;
  role: TeamRole;
  projectContext: ContextBlock[];
  guidelines: GuidelineForAi[];
  memory: WorkflowMemory;
}) {
  return renderSkill('grilling-questions', {
    projectName: attribute(input.project.name),
    round: input.round,
    role: input.role,
    roundFocus: ROUND_FOCUS[input.round],
    context: renderContext(input.projectContext, { projectLevel: true }),
    guidelines: renderGuidelines(input.guidelines),
    memory: renderMemory(input.memory),
  });
}

export function draftBriefFromGrillingPrompt(input: {
  project: ProjectForAi;
  briefMarkdown: string;
  projectContext: ContextBlock[];
  guidelines: GuidelineForAi[];
  memory: WorkflowMemory;
  answers: GrillingAnswerForAi[];
}) {
  return renderSkill('draft-brief-from-grilling', {
    projectName: attribute(input.project.name),
    brief: fence(input.briefMarkdown),
    context: renderContext(input.projectContext, { projectLevel: true }),
    guidelines: renderGuidelines(input.guidelines),
    memory: renderMemory(input.memory),
    answers: renderGrillingAnswers(input.answers),
  });
}
