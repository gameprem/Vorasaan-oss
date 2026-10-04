-- CreateEnum
CREATE TYPE "ReceiptOutputKind" AS ENUM ('CHOICES', 'SPEC_PROPOSAL', 'BRIEF_PROPOSAL', 'FEATURE_SUGGESTION_BATCH', 'REDRAFT', 'CONVERSATION_MESSAGE', 'CONVERSATION', 'ATTACHMENT', 'GRILLING_ROUND', 'GRILLING_QUESTION');

-- CreateEnum
CREATE TYPE "ReceiptOutcomeKind" AS ENUM ('APPROVE', 'DECLINE', 'REQUEST_CHANGES', 'MANUAL_EDIT');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "receiptRetentionDays" INTEGER NOT NULL DEFAULT 90,
ADD COLUMN     "receiptsEnabled" BOOLEAN NOT NULL DEFAULT true;

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "task" TEXT NOT NULL,
    "taskKind" TEXT NOT NULL,
    "promptName" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "modelSource" TEXT,
    "approvedModelId" TEXT,
    "modelName" TEXT,
    "providerKind" TEXT,
    "language" TEXT,
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "cacheReadTokens" INTEGER,
    "cacheWriteTokens" INTEGER,
    "latencyMs" INTEGER NOT NULL,
    "success" BOOLEAN NOT NULL,
    "error" TEXT,
    "outputKind" "ReceiptOutputKind",
    "outputId" TEXT,
    "proposalKind" "ProposalKind",
    "proposalId" TEXT,
    "redraft" INTEGER,
    "requestedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReceiptOutcome" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "redraftReceiptId" TEXT,
    "kind" "ReceiptOutcomeKind" NOT NULL,
    "proposalKind" "ProposalKind" NOT NULL,
    "proposalId" TEXT NOT NULL,
    "redraft" INTEGER NOT NULL,
    "reason" TEXT,
    "redraftsBeforeApproval" INTEGER,
    "choiceLabel" TEXT,
    "editSize" INTEGER,
    "actorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReceiptOutcome_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Receipt_createdAt_idx" ON "Receipt"("createdAt");

-- CreateIndex
CREATE INDEX "Receipt_proposalKind_proposalId_redraft_idx" ON "Receipt"("proposalKind", "proposalId", "redraft");

-- CreateIndex
CREATE INDEX "Receipt_outputKind_outputId_idx" ON "Receipt"("outputKind", "outputId");

-- CreateIndex
CREATE INDEX "Receipt_requestedById_idx" ON "Receipt"("requestedById");

-- CreateIndex
CREATE INDEX "ReceiptOutcome_receiptId_idx" ON "ReceiptOutcome"("receiptId");

-- CreateIndex
CREATE INDEX "ReceiptOutcome_redraftReceiptId_idx" ON "ReceiptOutcome"("redraftReceiptId");

-- CreateIndex
CREATE INDEX "ReceiptOutcome_proposalKind_proposalId_idx" ON "ReceiptOutcome"("proposalKind", "proposalId");

-- CreateIndex
CREATE INDEX "ReceiptOutcome_createdAt_idx" ON "ReceiptOutcome"("createdAt");

-- CreateIndex
CREATE INDEX "ReceiptOutcome_actorId_idx" ON "ReceiptOutcome"("actorId");

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptOutcome" ADD CONSTRAINT "ReceiptOutcome_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptOutcome" ADD CONSTRAINT "ReceiptOutcome_redraftReceiptId_fkey" FOREIGN KEY ("redraftReceiptId") REFERENCES "Receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptOutcome" ADD CONSTRAINT "ReceiptOutcome_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
