import { DecisionRequestKind } from '@vorasaan/shared';
import { z } from 'zod';
import type { ChatTool } from '../ai/ai.port.ts';

// The tools the AI may call in a Conversation (ADR 0008, ticket 0043). Each one
// only drafts something a person then approves on its Action Card, or reads
// what the person may already read. None approves, sends, accepts or decides.

const Markdown = z.string().trim().min(1).max(100_000);
const Summary = z.string().trim().min(1).max(300);

export const SearchContextArgs = z.object({
  query: z.string().trim().min(1).max(500),
});

export const DraftDecisionRequestArgs = z.object({
  kind: DecisionRequestKind,
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(10_000),
  /** false: a plain-text Question without Choices. */
  withChoices: z.boolean().optional(),
});

export const DraftProposalArgs = z.object({
  proposedMarkdown: Markdown,
  summary: Summary,
});

export const SuggestFeaturesArgs = z.object({
  count: z.int().min(1).max(5).optional(),
});

export type ChatToolName =
  | 'searchContext'
  | 'draftDecisionRequest'
  | 'draftSpecProposal'
  | 'draftBriefProposal'
  | 'suggestFeatures';

const TOOLS: Record<ChatToolName, ChatTool> = {
  searchContext: {
    name: 'searchContext',
    description:
      "Searches this Conversation's scope (its Spec, Decisions, Decision Requests, Attachments, " +
      'Project Brief and Features) for material about `query`, beyond what you were given. Read-only.',
    inputSchema: SearchContextArgs,
  },
  draftDecisionRequest: {
    name: 'draftDecisionRequest',
    description:
      'Drafts a Decision Request on this Feature, raised by the person: a BLOCKER (stops their work) ' +
      'or a QUESTION. Vorasaan adds AI-suggested Choices and a suggested Team Role. It stays a draft ' +
      'until the person reviews and sends it from its Action Card. Only a Role Owner of the Feature may raise one.',
    inputSchema: DraftDecisionRequestArgs,
  },
  draftSpecProposal: {
    name: 'draftSpecProposal',
    description:
      'Drafts a Spec Proposal for this Feature: `proposedMarkdown` is the complete new Spec in Markdown ' +
      '(not a diff), `summary` one line on what changes. It becomes a Spec Version only if the person ' +
      "approves its Action Card. Only an Admin or the Feature's PO may propose one.",
    inputSchema: DraftProposalArgs,
  },
  draftBriefProposal: {
    name: 'draftBriefProposal',
    description:
      'Drafts a Brief Proposal for this Project: `proposedMarkdown` is the complete new Project Brief ' +
      'in Markdown (not a diff), `summary` one line on what changes. It becomes a Brief Version only if ' +
      "the person approves its Action Card. Only an Admin or a PO of the Project's Teams may propose one.",
    inputSchema: DraftProposalArgs,
  },
  suggestFeatures: {
    name: 'suggestFeatures',
    description:
      'Generates up to `count` (default 3, at most 5) Feature Suggestions for this Project from its ' +
      'Brief, Feature Guidelines and Decision Log. Each appears as an Action Card the person accepts or ' +
      "dismisses. Only an Admin or a PO of the Project's Teams may ask for them.",
    inputSchema: SuggestFeaturesArgs,
  },
};

/** The default `suggestFeatures` count, kept small for a chat. */
export const DEFAULT_CHAT_SUGGESTIONS = 3;

/** What the AI may call in a Feature Conversation, or in a Project Conversation. */
export function chatToolsFor(scope: { featureId: string | null }): ChatTool[] {
  const names: ChatToolName[] = scope.featureId
    ? ['searchContext', 'draftDecisionRequest', 'draftSpecProposal']
    : ['searchContext', 'draftBriefProposal', 'suggestFeatures'];
  return names.map((name) => TOOLS[name]);
}
