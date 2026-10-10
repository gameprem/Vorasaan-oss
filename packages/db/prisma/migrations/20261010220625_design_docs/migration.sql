-- CreateEnum
CREATE TYPE "DesignTemplateKind" AS ENUM ('BACK_END', 'FRONT_END', 'MOBILE', 'QA');

-- CreateEnum
CREATE TYPE "DesignDocVersionSource" AS ENUM ('AI_DRAFT', 'REVERT');

-- CreateEnum
CREATE TYPE "DesignDocProposalReason" AS ENUM ('FIRST_DRAFT', 'SPEC_CHANGED');

-- CreateEnum
CREATE TYPE "DesignDocProposalStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'SUPERSEDED');

-- AlterEnum
ALTER TYPE "AiTaskKind" ADD VALUE 'DESIGN_DOCS';

-- AlterEnum
ALTER TYPE "ProposalKind" ADD VALUE 'DESIGN_DOC_PROPOSAL';

-- AlterEnum
ALTER TYPE "ReceiptOutputKind" ADD VALUE 'DESIGN_DOC_PROPOSAL';

-- AlterTable
ALTER TABLE "DecisionRequest" ADD COLUMN     "designDocId" TEXT;

-- AlterTable
ALTER TABLE "OrgPlatformTemplate" ADD COLUMN     "designTemplate" "DesignTemplateKind";

-- AlterTable
ALTER TABLE "Platform" ADD COLUMN     "designTemplate" "DesignTemplateKind";

-- AlterTable
ALTER TABLE "Redraft" ADD COLUMN     "designDocProposalId" TEXT;

-- CreateTable
CREATE TABLE "DesignTemplate" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "DesignTemplateKind" NOT NULL,
    "markdown" TEXT NOT NULL,
    "updatedById" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DesignTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignDoc" (
    "id" TEXT NOT NULL,
    "featureId" TEXT NOT NULL,
    "platformId" TEXT,
    "template" "DesignTemplateKind" NOT NULL,
    "draftingAt" TIMESTAMP(3),
    "draftError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignDoc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignDocVersion" (
    "id" TEXT NOT NULL,
    "designDocId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "markdown" TEXT NOT NULL,
    "source" "DesignDocVersionSource" NOT NULL,
    "summary" TEXT,
    "specVersionId" TEXT NOT NULL,
    "approvedById" TEXT NOT NULL,
    "proposalId" TEXT,
    "revertedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignDocVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DesignDocProposal" (
    "id" TEXT NOT NULL,
    "designDocId" TEXT NOT NULL,
    "reason" "DesignDocProposalReason" NOT NULL,
    "specVersionId" TEXT NOT NULL,
    "baseVersionId" TEXT,
    "proposedMarkdown" TEXT NOT NULL,
    "summary" TEXT,
    "status" "DesignDocProposalStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "approvedModelId" TEXT,
    "modelDisplayName" TEXT,
    "modelName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DesignDocProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DesignTemplate_projectId_kind_key" ON "DesignTemplate"("projectId", "kind");

-- CreateIndex
CREATE INDEX "DesignDoc_featureId_idx" ON "DesignDoc"("featureId");

-- CreateIndex
CREATE INDEX "DesignDoc_platformId_idx" ON "DesignDoc"("platformId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignDocVersion_proposalId_key" ON "DesignDocVersion"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "DesignDocVersion_designDocId_version_key" ON "DesignDocVersion"("designDocId", "version");

-- CreateIndex
CREATE INDEX "DesignDocProposal_designDocId_status_idx" ON "DesignDocProposal"("designDocId", "status");

-- CreateIndex
CREATE INDEX "DesignDocProposal_status_idx" ON "DesignDocProposal"("status");

-- CreateIndex
CREATE INDEX "DecisionRequest_designDocId_idx" ON "DecisionRequest"("designDocId");

-- CreateIndex
CREATE INDEX "Redraft_designDocProposalId_idx" ON "Redraft"("designDocProposalId");

-- AddForeignKey
ALTER TABLE "DecisionRequest" ADD CONSTRAINT "DecisionRequest_designDocId_fkey" FOREIGN KEY ("designDocId") REFERENCES "DesignDoc"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redraft" ADD CONSTRAINT "Redraft_designDocProposalId_fkey" FOREIGN KEY ("designDocProposalId") REFERENCES "DesignDocProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignTemplate" ADD CONSTRAINT "DesignTemplate_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignTemplate" ADD CONSTRAINT "DesignTemplate_updatedById_fkey" FOREIGN KEY ("updatedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignDoc" ADD CONSTRAINT "DesignDoc_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignDoc" ADD CONSTRAINT "DesignDoc_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "Platform"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignDocVersion" ADD CONSTRAINT "DesignDocVersion_designDocId_fkey" FOREIGN KEY ("designDocId") REFERENCES "DesignDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignDocVersion" ADD CONSTRAINT "DesignDocVersion_specVersionId_fkey" FOREIGN KEY ("specVersionId") REFERENCES "SpecVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignDocVersion" ADD CONSTRAINT "DesignDocVersion_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignDocVersion" ADD CONSTRAINT "DesignDocVersion_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "DesignDocProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignDocVersion" ADD CONSTRAINT "DesignDocVersion_revertedFromId_fkey" FOREIGN KEY ("revertedFromId") REFERENCES "DesignDocVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignDocProposal" ADD CONSTRAINT "DesignDocProposal_designDocId_fkey" FOREIGN KEY ("designDocId") REFERENCES "DesignDoc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignDocProposal" ADD CONSTRAINT "DesignDocProposal_specVersionId_fkey" FOREIGN KEY ("specVersionId") REFERENCES "SpecVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignDocProposal" ADD CONSTRAINT "DesignDocProposal_baseVersionId_fkey" FOREIGN KEY ("baseVersionId") REFERENCES "DesignDocVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DesignDocProposal" ADD CONSTRAINT "DesignDocProposal_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- One Design Doc per Feature and target Platform, and one QA Design Doc per Feature
-- (platformId null), which a plain unique index would allow many of.
CREATE UNIQUE INDEX "DesignDoc_featureId_platformId_key" ON "DesignDoc"("featureId", "platformId") WHERE "platformId" IS NOT NULL;
CREATE UNIQUE INDEX "DesignDoc_one_qa_per_feature" ON "DesignDoc"("featureId") WHERE "platformId" IS NULL;

-- At most one PENDING proposal per Design Doc: a newer draft supersedes it first.
CREATE UNIQUE INDEX "DesignDocProposal_one_pending" ON "DesignDocProposal"("designDocId") WHERE "status" = 'PENDING';

-- A Redraft of a Design Doc proposal (ticket 0069) sets only "designDocProposalId". The kind
-- is compared as text: the enum value added above can't be used in this same transaction.
ALTER TABLE "Redraft" DROP CONSTRAINT "Redraft_proposal_check";
ALTER TABLE "Redraft" ADD CONSTRAINT "Redraft_proposal_check" CHECK (
  CASE "proposalKind"::text
    WHEN 'CHOICES' THEN "requestId" = "proposalId" AND "specProposalId" IS NULL AND "briefProposalId" IS NULL AND "featureSuggestionId" IS NULL AND "promptVersionId" IS NULL AND "designDocProposalId" IS NULL
    WHEN 'SPEC_PROPOSAL' THEN "specProposalId" = "proposalId" AND "requestId" IS NULL AND "briefProposalId" IS NULL AND "featureSuggestionId" IS NULL AND "promptVersionId" IS NULL AND "designDocProposalId" IS NULL
    WHEN 'BRIEF_PROPOSAL' THEN "briefProposalId" = "proposalId" AND "requestId" IS NULL AND "specProposalId" IS NULL AND "featureSuggestionId" IS NULL AND "promptVersionId" IS NULL AND "designDocProposalId" IS NULL
    WHEN 'FEATURE_SUGGESTION' THEN "featureSuggestionId" = "proposalId" AND "requestId" IS NULL AND "specProposalId" IS NULL AND "briefProposalId" IS NULL AND "promptVersionId" IS NULL AND "designDocProposalId" IS NULL
    WHEN 'PROMPT_VERSION' THEN "promptVersionId" = "proposalId" AND "requestId" IS NULL AND "specProposalId" IS NULL AND "briefProposalId" IS NULL AND "featureSuggestionId" IS NULL AND "designDocProposalId" IS NULL
    WHEN 'DESIGN_DOC_PROPOSAL' THEN "designDocProposalId" = "proposalId" AND "requestId" IS NULL AND "specProposalId" IS NULL AND "briefProposalId" IS NULL AND "featureSuggestionId" IS NULL AND "promptVersionId" IS NULL
  END
);
