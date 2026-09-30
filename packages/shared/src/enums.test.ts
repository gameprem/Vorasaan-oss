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
] as const;

describe('shared enums mirror Prisma', () => {
  for (const [name, zodEnum, prismaEnum] of pairs) {
    test(name, () => {
      expect([...zodEnum.options].sort()).toEqual(Object.values(prismaEnum).sort());
    });
  }
});
