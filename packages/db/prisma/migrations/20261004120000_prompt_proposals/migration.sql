-- CreateEnum
CREATE TYPE "PromptAnalysisStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "PromptAnalysisTrigger" AS ENUM ('MANUAL', 'FEEDBACK');

-- AlterEnum
ALTER TYPE "AiTaskKind" ADD VALUE 'PROMPT_PROPOSALS';

-- AlterEnum
ALTER TYPE "ProposalKind" ADD VALUE 'PROMPT_VERSION';

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "ReceiptOutputKind" ADD VALUE 'PROMPT_ANALYSIS';
ALTER TYPE "ReceiptOutputKind" ADD VALUE 'PROMPT_VERSION';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "promptAnalysisAfter" INTEGER NOT NULL DEFAULT 20;

-- AlterTable
ALTER TABLE "PromptVersion" ADD COLUMN     "analysisId" TEXT,
ADD COLUMN     "baselineRunId" TEXT,
ADD COLUMN     "evalRunId" TEXT,
ADD COLUMN     "rationale" TEXT;

-- AlterTable
ALTER TABLE "Redraft" ADD COLUMN     "promptVersionId" TEXT;

-- CreateTable
CREATE TABLE "PromptAnalysis" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "promptName" TEXT NOT NULL,
    "trigger" "PromptAnalysisTrigger" NOT NULL,
    "status" "PromptAnalysisStatus" NOT NULL DEFAULT 'RUNNING',
    "outcomes" INTEGER NOT NULL DEFAULT 0,
    "patterns" JSONB,
    "error" TEXT,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "PromptAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromptAnalysis_organizationId_promptName_createdAt_idx" ON "PromptAnalysis"("organizationId", "promptName", "createdAt");

-- CreateIndex
CREATE INDEX "PromptAnalysis_requestedById_idx" ON "PromptAnalysis"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_analysisId_key" ON "PromptVersion"("analysisId");

-- CreateIndex
CREATE INDEX "PromptVersion_evalRunId_idx" ON "PromptVersion"("evalRunId");

-- CreateIndex
CREATE INDEX "PromptVersion_baselineRunId_idx" ON "PromptVersion"("baselineRunId");

-- CreateIndex
CREATE INDEX "Redraft_promptVersionId_idx" ON "Redraft"("promptVersionId");

-- AddForeignKey
ALTER TABLE "Redraft" ADD CONSTRAINT "Redraft_promptVersionId_fkey" FOREIGN KEY ("promptVersionId") REFERENCES "PromptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "PromptAnalysis"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_evalRunId_fkey" FOREIGN KEY ("evalRunId") REFERENCES "PromptEvalRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_baselineRunId_fkey" FOREIGN KEY ("baselineRunId") REFERENCES "PromptEvalRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptAnalysis" ADD CONSTRAINT "PromptAnalysis_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptAnalysis" ADD CONSTRAINT "PromptAnalysis_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A Redraft of a Prompt Version (ticket 0072) sets only "promptVersionId". The kind is
-- compared as text: the enum value added above can't be used in this same transaction.
ALTER TABLE "Redraft" DROP CONSTRAINT "Redraft_proposal_check";
ALTER TABLE "Redraft" ADD CONSTRAINT "Redraft_proposal_check" CHECK (
  CASE "proposalKind"::text
    WHEN 'CHOICES' THEN "requestId" = "proposalId" AND "specProposalId" IS NULL AND "briefProposalId" IS NULL AND "featureSuggestionId" IS NULL AND "promptVersionId" IS NULL
    WHEN 'SPEC_PROPOSAL' THEN "specProposalId" = "proposalId" AND "requestId" IS NULL AND "briefProposalId" IS NULL AND "featureSuggestionId" IS NULL AND "promptVersionId" IS NULL
    WHEN 'BRIEF_PROPOSAL' THEN "briefProposalId" = "proposalId" AND "requestId" IS NULL AND "specProposalId" IS NULL AND "featureSuggestionId" IS NULL AND "promptVersionId" IS NULL
    WHEN 'FEATURE_SUGGESTION' THEN "featureSuggestionId" = "proposalId" AND "requestId" IS NULL AND "specProposalId" IS NULL AND "briefProposalId" IS NULL AND "promptVersionId" IS NULL
    WHEN 'PROMPT_VERSION' THEN "promptVersionId" = "proposalId" AND "requestId" IS NULL AND "specProposalId" IS NULL AND "briefProposalId" IS NULL AND "featureSuggestionId" IS NULL
  END
);

-- One running analysis per prompt: an Admin's and the feedback trigger's never overlap.
CREATE UNIQUE INDEX "PromptAnalysis_one_running_per_prompt" ON "PromptAnalysis"("organizationId", "promptName") WHERE "status" = 'RUNNING';
