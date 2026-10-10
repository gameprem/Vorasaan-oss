-- CreateEnum
CREATE TYPE "PromptVersionStatus" AS ENUM ('PROPOSED', 'APPROVED', 'DECLINED');

-- CreateEnum
CREATE TYPE "PromptActivationKind" AS ENUM ('APPROVE', 'ROLLBACK');

-- CreateEnum
CREATE TYPE "PromptEvalRunStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN     "evalRunId" TEXT;

-- CreateTable
CREATE TABLE "PromptVersion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "promptName" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "template" TEXT NOT NULL,
    "note" TEXT,
    "status" "PromptVersionStatus" NOT NULL DEFAULT 'PROPOSED',
    "proposedById" TEXT,
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "declinedById" TEXT,
    "declinedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptActivation" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "organizationId" TEXT NOT NULL,
    "promptName" TEXT NOT NULL,
    "versionId" TEXT,
    "kind" "PromptActivationKind" NOT NULL,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptActivation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptEvalRun" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "promptName" TEXT NOT NULL,
    "versionId" TEXT,
    "promptVersion" TEXT NOT NULL,
    "approvedModelId" TEXT,
    "modelDisplayName" TEXT NOT NULL,
    "modelName" TEXT NOT NULL,
    "sources" TEXT[],
    "status" "PromptEvalRunStatus" NOT NULL DEFAULT 'RUNNING',
    "total" INTEGER NOT NULL DEFAULT 0,
    "done" INTEGER NOT NULL DEFAULT 0,
    "score" DOUBLE PRECISION,
    "error" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "cacheWriteTokens" INTEGER,
    "startedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "PromptEvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PromptEvalCase" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "set" TEXT NOT NULL,
    "caseKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "score" DOUBLE PRECISION NOT NULL,
    "checks" JSONB NOT NULL,
    "output" JSONB,
    "error" TEXT,
    "receiptId" TEXT,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PromptEvalCase_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PromptVersion_proposedById_idx" ON "PromptVersion"("proposedById");

-- CreateIndex
CREATE INDEX "PromptVersion_approvedById_idx" ON "PromptVersion"("approvedById");

-- CreateIndex
CREATE INDEX "PromptVersion_declinedById_idx" ON "PromptVersion"("declinedById");

-- CreateIndex
CREATE UNIQUE INDEX "PromptVersion_organizationId_promptName_number_key" ON "PromptVersion"("organizationId", "promptName", "number");

-- CreateIndex
CREATE INDEX "PromptActivation_organizationId_promptName_seq_idx" ON "PromptActivation"("organizationId", "promptName", "seq");

-- CreateIndex
CREATE INDEX "PromptActivation_versionId_idx" ON "PromptActivation"("versionId");

-- CreateIndex
CREATE INDEX "PromptActivation_actorId_idx" ON "PromptActivation"("actorId");

-- CreateIndex
CREATE INDEX "PromptEvalRun_organizationId_promptName_createdAt_idx" ON "PromptEvalRun"("organizationId", "promptName", "createdAt");

-- CreateIndex
CREATE INDEX "PromptEvalRun_versionId_idx" ON "PromptEvalRun"("versionId");

-- CreateIndex
CREATE INDEX "PromptEvalRun_startedById_idx" ON "PromptEvalRun"("startedById");

-- CreateIndex
CREATE UNIQUE INDEX "PromptEvalCase_runId_caseKey_key" ON "PromptEvalCase"("runId", "caseKey");

-- CreateIndex
CREATE INDEX "Receipt_evalRunId_idx" ON "Receipt"("evalRunId");

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_proposedById_fkey" FOREIGN KEY ("proposedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_approvedById_fkey" FOREIGN KEY ("approvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptVersion" ADD CONSTRAINT "PromptVersion_declinedById_fkey" FOREIGN KEY ("declinedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptActivation" ADD CONSTRAINT "PromptActivation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptActivation" ADD CONSTRAINT "PromptActivation_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "PromptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptActivation" ADD CONSTRAINT "PromptActivation_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptEvalRun" ADD CONSTRAINT "PromptEvalRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptEvalRun" ADD CONSTRAINT "PromptEvalRun_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "PromptVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptEvalRun" ADD CONSTRAINT "PromptEvalRun_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PromptEvalCase" ADD CONSTRAINT "PromptEvalCase_runId_fkey" FOREIGN KEY ("runId") REFERENCES "PromptEvalRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
