import { renderSkill } from '@vorasaan/skills';
import type { AttachmentForAi, DecisionForAi, FeatureForAi, RequestForAi } from './ai.port.ts';

const KIND_MEANING = {
  BLOCKER: "the Raiser's work is stopped until this is decided",
  QUESTION: 'the Raiser can keep working meanwhile',
} as const;

/**
 * Neutralises anything in untrusted text that could open or close an
 * <attachment> block, so Attachment content can't escape its fence in the prompt.
 */
function fence(text: string): string {
  return text.replace(/<(\s*\/?\s*attachment)/gi, '‹$1');
}

/** Attachments as fenced, numbered data blocks. Titles are untrusted too. */
export function renderAttachments(attachments: AttachmentForAi[]): string {
  if (attachments.length === 0) return '(No Attachments.)';
  return attachments
    .map((a, i) => {
      const title = fence(a.title)
        .replace(/["\r\n]+/g, ' ')
        .trim();
      return `<attachment index="${i + 1}" source="${a.source}" title="${title}">\n${fence(a.text)}\n</attachment>`;
    })
    .join('\n\n');
}

export function generateChoicesPrompt(
  specMarkdown: string,
  request: RequestForAi,
  attachments: AttachmentForAi[],
) {
  return renderSkill('generate-choices', {
    spec: specMarkdown,
    attachments: renderAttachments(attachments),
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
  attachments: AttachmentForAi[],
) {
  return renderSkill('draft-spec-proposal', {
    spec: specMarkdown,
    attachments: renderAttachments(attachments),
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
  attachments: AttachmentForAi[],
) {
  return renderSkill('draft-spec-from-attachments', {
    featureTitle: feature.title,
    featureDescription: feature.description || '(No description.)',
    spec: specMarkdown || '(No Spec yet: this will be the first version.)',
    attachments: renderAttachments(attachments),
  });
}
