-- CreateEnum
CREATE TYPE "BriefVersionSource" AS ENUM ('MANUAL', 'GRILLING', 'REVERT');

-- AlterEnum
ALTER TYPE "ChunkSource" ADD VALUE 'BRIEF_VERSION';

-- AlterTable
ALTER TABLE "Attachment" ADD COLUMN     "projectId" TEXT,
ALTER COLUMN "featureId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "BriefVersion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "markdown" TEXT NOT NULL,
    "source" "BriefVersionSource" NOT NULL,
    "summary" TEXT,
    "approvedById" TEXT NOT NULL,
    "proposalId" TEXT,
    "revertedFromId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BriefVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BriefProposal" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "baseVersionId" TEXT,
    "source" "BriefVersionSource" NOT NULL,
    "proposedMarkdown" TEXT NOT NULL,
    "status" "ProposalStatus" NOT NULL DEFAULT 'PENDING',
    "approverId" TEXT NOT NULL,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BriefProposal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BriefVersion_proposalId_key" ON "BriefVersion"("proposalId");

-- CreateIndex
CREATE UNIQUE INDEX "BriefVersion_projectId_version_key" ON "BriefVersion"("projectId", "version");

-- CreateIndex
CREATE INDEX "BriefProposal_approverId_status_idx" ON "BriefProposal"("approverId", "status");

-- CreateIndex
CREATE INDEX "BriefProposal_projectId_status_idx" ON "BriefProposal"("projectId", "status");

-- CreateIndex
CREATE INDEX "Attachment_projectId_idx" ON "Attachment"("projectId");

-- AddForeignKey
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BriefVersion" ADD CONSTRAINT "BriefVersion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BriefVersion" ADD CONSTRAINT "BriefVersion_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BriefVersion" ADD CONSTRAINT "BriefVersion_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "BriefProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BriefVersion" ADD CONSTRAINT "BriefVersion_revertedFromId_fkey" FOREIGN KEY ("revertedFromId") REFERENCES "BriefVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BriefProposal" ADD CONSTRAINT "BriefProposal_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BriefProposal" ADD CONSTRAINT "BriefProposal_baseVersionId_fkey" FOREIGN KEY ("baseVersionId") REFERENCES "BriefVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BriefProposal" ADD CONSTRAINT "BriefProposal_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- An Attachment belongs to exactly one Feature or one Project. Existing rows all
-- have a featureId, so they already satisfy it.
ALTER TABLE "Attachment" ADD CONSTRAINT "Attachment_exactly_one_owner"
  CHECK (("featureId" IS NULL) <> ("projectId" IS NULL));

