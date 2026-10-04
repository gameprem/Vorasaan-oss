import { describe, expect, test } from 'bun:test';
import * as db from '@vorasaan/db';
import * as shared from './enums.ts';

const pairs = [
  ['OrgRole', shared.OrgRole, db.OrgRole],
  ['TeamRole', shared.TeamRole, db.TeamRole],
  ['DecisionRequestKind', shared.DecisionRequestKind, db.DecisionRequestKind],
  ['DecisionRequestStatus', shared.DecisionRequestStatus, db.DecisionRequestStatus],
  ['RequestMessageKind', shared.RequestMessageKind, db.RequestMessageKind],
  ['ProposalStatus', shared.ProposalStatus, db.ProposalStatus],
  ['SpecVersionSource', shared.SpecVersionSource, db.SpecVersionSource],
  ['BriefVersionSource', shared.BriefVersionSource, db.BriefVersionSource],
  ['GuidelineCriterionKind', shared.GuidelineCriterionKind, db.GuidelineCriterionKind],
  ['AttachmentSource', shared.AttachmentSource, db.AttachmentSource],
  ['NotificationType', shared.NotificationType, db.NotificationType],
  ['GrillingStatus', shared.GrillingStatus, db.GrillingStatus],
  ['GrillingRoundKind', shared.GrillingRoundKind, db.GrillingRoundKind],
  ['GrillingRoundStatus', shared.GrillingRoundStatus, db.GrillingRoundStatus],
  ['GrillingSkipReason', shared.GrillingSkipReason, db.GrillingSkipReason],
  ['FeatureSuggestionStatus', shared.FeatureSuggestionStatus, db.FeatureSuggestionStatus],
  ['SuggestionLevel', shared.SuggestionLevel, db.SuggestionLevel],
  ['FeatureStatus', shared.FeatureStatus, db.FeatureStatus],
  ['ConversationMessageRole', shared.ConversationMessageRole, db.ConversationMessageRole],
  ['ActionCardKind', shared.ActionCardKind, db.ActionCardKind],
  ['ActionCardStatus', shared.ActionCardStatus, db.ActionCardStatus],
  ['ResponseWindowUnit', shared.ResponseWindowUnit, db.ResponseWindowUnit],
  ['RequestHistoryKind', shared.RequestHistoryKind, db.RequestHistoryKind],
  ['ChatProvider', shared.ChatProvider, db.ChatProvider],
  ['ChatEventKind', shared.ChatEventKind, db.ChatEventKind],
  ['DecisionSource', shared.DecisionSource, db.DecisionSource],
  ['ChatCardStatus', shared.ChatCardStatus, db.ChatCardStatus],
  ['ProposalKind', shared.ProposalKind, db.ProposalKind],
  ['RedraftStatus', shared.RedraftStatus, db.RedraftStatus],
  ['ReceiptOutputKind', shared.ReceiptOutputKind, db.ReceiptOutputKind],
  ['ReceiptOutcomeKind', shared.ReceiptOutcomeKind, db.ReceiptOutcomeKind],
] as const;

describe('shared enums mirror Prisma', () => {
  for (const [name, zodEnum, prismaEnum] of pairs) {
    test(name, () => {
      expect([...zodEnum.options].sort()).toEqual(Object.values(prismaEnum).sort());
    });
  }
});
