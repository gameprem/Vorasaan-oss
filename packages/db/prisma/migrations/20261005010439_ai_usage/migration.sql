-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "NotificationType" ADD VALUE 'AI_BUDGET_WARNING';
ALTER TYPE "NotificationType" ADD VALUE 'AI_BUDGET_REACHED';

-- AlterTable
ALTER TABLE "ApprovedModel" ADD COLUMN     "inputPricePerMillion" DOUBLE PRECISION,
ADD COLUMN     "outputPricePerMillion" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "aiMonthlyBudget" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "AiBudgetAlert" (
    "organizationId" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "threshold" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiBudgetAlert_pkey" PRIMARY KEY ("organizationId","month","threshold")
);

-- AddForeignKey
ALTER TABLE "AiBudgetAlert" ADD CONSTRAINT "AiBudgetAlert_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A price is both halves or none; prices and the budget are never negative.
ALTER TABLE "ApprovedModel" ADD CONSTRAINT "ApprovedModel_prices_check" CHECK (
  ("inputPricePerMillion" IS NULL) = ("outputPricePerMillion" IS NULL)
  AND COALESCE("inputPricePerMillion", 0) >= 0
  AND COALESCE("outputPricePerMillion", 0) >= 0
);
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_aiMonthlyBudget_check" CHECK (
  "aiMonthlyBudget" IS NULL OR "aiMonthlyBudget" > 0
);
ALTER TABLE "AiBudgetAlert" ADD CONSTRAINT "AiBudgetAlert_threshold_check" CHECK (
  "threshold" IN (80, 100)
);

-- The Project of the Receipts kept so far, from the records they point at, where those remain.
UPDATE "Receipt" r SET "projectId" = t."projectId"
FROM "DecisionRequest" d JOIN "Feature" f ON f.id = d."featureId" JOIN "Team" t ON t.id = f."teamId"
WHERE r."projectId" IS NULL AND r."proposalKind" = 'CHOICES' AND r."proposalId" = d.id;

UPDATE "Receipt" r SET "projectId" = t."projectId"
FROM "SpecProposal" p JOIN "Feature" f ON f.id = p."featureId" JOIN "Team" t ON t.id = f."teamId"
WHERE r."projectId" IS NULL AND r."proposalKind" = 'SPEC_PROPOSAL' AND r."proposalId" = p.id;

UPDATE "Receipt" r SET "projectId" = p."projectId"
FROM "BriefProposal" p
WHERE r."projectId" IS NULL AND r."proposalKind" = 'BRIEF_PROPOSAL' AND r."proposalId" = p.id;

UPDATE "Receipt" r SET "projectId" = s."projectId"
FROM "FeatureSuggestion" s
WHERE r."projectId" IS NULL
  AND ((r."proposalKind" = 'FEATURE_SUGGESTION' AND r."proposalId" = s.id)
    OR (r."outputKind" = 'FEATURE_SUGGESTION_BATCH' AND r."outputId" = s."batchId"));

UPDATE "Receipt" r SET "projectId" = c."projectId"
FROM "Conversation" c
WHERE r."projectId" IS NULL AND r."outputKind" = 'CONVERSATION' AND r."outputId" = c.id;

UPDATE "Receipt" r SET "projectId" = c."projectId"
FROM "ConversationMessage" m JOIN "Conversation" c ON c.id = m."conversationId"
WHERE r."projectId" IS NULL AND r."outputKind" = 'CONVERSATION_MESSAGE' AND r."outputId" = m.id;

UPDATE "Receipt" r SET "projectId" = COALESCE(a."projectId", t."projectId")
FROM "Attachment" a LEFT JOIN "Feature" f ON f.id = a."featureId" LEFT JOIN "Team" t ON t.id = f."teamId"
WHERE r."projectId" IS NULL AND r."outputKind" = 'ATTACHMENT' AND r."outputId" = a.id;

UPDATE "Receipt" r SET "projectId" = g."projectId"
FROM "GrillingRound" gr JOIN "Grilling" g ON g.id = gr."grillingId"
WHERE r."projectId" IS NULL AND r."outputKind" = 'GRILLING_ROUND' AND r."outputId" = gr.id;

UPDATE "Receipt" r SET "projectId" = g."projectId"
FROM "GrillingQuestion" q JOIN "Grilling" g ON g.id = q."grillingId"
WHERE r."projectId" IS NULL AND r."outputKind" = 'GRILLING_QUESTION' AND r."outputId" = q.id;
