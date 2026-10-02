-- CreateEnum
CREATE TYPE "ActionCardKind" AS ENUM ('DECISION_REQUEST', 'SPEC_PROPOSAL', 'BRIEF_PROPOSAL', 'FEATURE_SUGGESTION');

-- CreateEnum
CREATE TYPE "ActionCardStatus" AS ENUM ('PROPOSED', 'APPROVED', 'DECLINED', 'STALE');

-- AlterEnum
ALTER TYPE "BriefVersionSource" ADD VALUE 'CONVERSATION';

-- AlterEnum
ALTER TYPE "SpecVersionSource" ADD VALUE 'CONVERSATION';

-- CreateTable
CREATE TABLE "ActionCard" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "toolCallId" TEXT NOT NULL,
    "kind" "ActionCardKind" NOT NULL,
    "targetId" TEXT NOT NULL,
    "status" "ActionCardStatus" NOT NULL DEFAULT 'PROPOSED',
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ActionCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ActionCard_conversationId_createdAt_idx" ON "ActionCard"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "ActionCard_messageId_idx" ON "ActionCard"("messageId");

-- CreateIndex
CREATE UNIQUE INDEX "ActionCard_kind_targetId_key" ON "ActionCard"("kind", "targetId");

-- AddForeignKey
ALTER TABLE "ActionCard" ADD CONSTRAINT "ActionCard_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ActionCard" ADD CONSTRAINT "ActionCard_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "ConversationMessage"("id") ON DELETE CASCADE ON UPDATE CASCADE;

