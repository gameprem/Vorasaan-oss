-- Request changes and Redrafts (ADR 0013, ticket 0065): every Redraft of an AI proposal,
-- with the feedback that caused it. The proposal itself always holds its latest READY one.
-- CreateEnum
CREATE TYPE "ProposalKind" AS ENUM ('CHOICES', 'SPEC_PROPOSAL', 'BRIEF_PROPOSAL', 'FEATURE_SUGGESTION');

-- CreateEnum
CREATE TYPE "RedraftStatus" AS ENUM ('WRITING', 'READY');

-- CreateTable
CREATE TABLE "Redraft" (
    "id" TEXT NOT NULL,
    "proposalKind" "ProposalKind" NOT NULL,
    "proposalId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "RedraftStatus" NOT NULL DEFAULT 'READY',
    "content" JSONB,
    "feedback" TEXT,
    "pointer" JSONB,
    "requestedById" TEXT,
    "summary" TEXT,
    "preferences" TEXT[],
    "approvedModelId" TEXT,
    "modelDisplayName" TEXT,
    "modelName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "readyAt" TIMESTAMP(3),
    "requestId" TEXT,
    "specProposalId" TEXT,
    "briefProposalId" TEXT,
    "featureSuggestionId" TEXT,

    CONSTRAINT "Redraft_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Redraft_requestId_idx" ON "Redraft"("requestId");

-- CreateIndex
CREATE INDEX "Redraft_specProposalId_idx" ON "Redraft"("specProposalId");

-- CreateIndex
CREATE INDEX "Redraft_briefProposalId_idx" ON "Redraft"("briefProposalId");

-- CreateIndex
CREATE INDEX "Redraft_featureSuggestionId_idx" ON "Redraft"("featureSuggestionId");

-- CreateIndex
CREATE INDEX "Redraft_requestedById_idx" ON "Redraft"("requestedById");

-- CreateIndex
CREATE UNIQUE INDEX "Redraft_proposalKind_proposalId_number_key" ON "Redraft"("proposalKind", "proposalId", "number");

-- AddForeignKey
ALTER TABLE "Redraft" ADD CONSTRAINT "Redraft_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redraft" ADD CONSTRAINT "Redraft_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "DecisionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redraft" ADD CONSTRAINT "Redraft_specProposalId_fkey" FOREIGN KEY ("specProposalId") REFERENCES "SpecProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redraft" ADD CONSTRAINT "Redraft_briefProposalId_fkey" FOREIGN KEY ("briefProposalId") REFERENCES "BriefProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Redraft" ADD CONSTRAINT "Redraft_featureSuggestionId_fkey" FOREIGN KEY ("featureSuggestionId") REFERENCES "FeatureSuggestion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one Redraft being written per proposal: a second Request changes waits (409).
CREATE UNIQUE INDEX "Redraft_one_writing_per_proposal" ON "Redraft"("proposalKind", "proposalId") WHERE "status" = 'WRITING';

-- Exactly the proposal id of its kind is set, and it is `proposalId`; numbers start at 1.
ALTER TABLE "Redraft" ADD CONSTRAINT "Redraft_proposal_check" CHECK (
  CASE "proposalKind"
    WHEN 'CHOICES' THEN "requestId" = "proposalId" AND "specProposalId" IS NULL AND "briefProposalId" IS NULL AND "featureSuggestionId" IS NULL
    WHEN 'SPEC_PROPOSAL' THEN "specProposalId" = "proposalId" AND "requestId" IS NULL AND "briefProposalId" IS NULL AND "featureSuggestionId" IS NULL
    WHEN 'BRIEF_PROPOSAL' THEN "briefProposalId" = "proposalId" AND "requestId" IS NULL AND "specProposalId" IS NULL AND "featureSuggestionId" IS NULL
    WHEN 'FEATURE_SUGGESTION' THEN "featureSuggestionId" = "proposalId" AND "requestId" IS NULL AND "specProposalId" IS NULL AND "briefProposalId" IS NULL
  END
);
ALTER TABLE "Redraft" ADD CONSTRAINT "Redraft_number_check" CHECK ("number" >= 1);
-- A READY Redraft has its content; Redraft 1 is the proposal as drafted, every later one has feedback.
ALTER TABLE "Redraft" ADD CONSTRAINT "Redraft_ready_check" CHECK (("status" = 'WRITING' OR "content" IS NOT NULL) AND ("number" = 1 OR "feedback" IS NOT NULL));
