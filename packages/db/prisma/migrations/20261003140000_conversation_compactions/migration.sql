-- CreateEnum
CREATE TYPE "ConversationCompactionTrigger" AS ENUM ('AUTO', 'MANUAL', 'TOO_LONG');

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "lastCacheReadTokens" INTEGER,
ADD COLUMN     "lastInputTokens" INTEGER;

-- CreateTable
CREATE TABLE "ConversationCompaction" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "trigger" "ConversationCompactionTrigger" NOT NULL,
    "focus" TEXT,
    "summarizedThrough" INTEGER NOT NULL,
    "summary" TEXT NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationCompaction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ConversationCompaction_createdById_idx" ON "ConversationCompaction"("createdById");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationCompaction_conversationId_number_key" ON "ConversationCompaction"("conversationId", "number");

-- AddForeignKey
ALTER TABLE "ConversationCompaction" ADD CONSTRAINT "ConversationCompaction_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationCompaction" ADD CONSTRAINT "ConversationCompaction_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Conversations compacted before ticket 0066 get their one compaction back, so the
-- web draws its divider and shows the summary as it is now.
INSERT INTO "ConversationCompaction" ("id", "conversationId", "number", "trigger", "summarizedThrough", "summary", "createdAt")
SELECT gen_random_uuid()::text, "id", 1, 'AUTO', "summarizedThrough", "summary", "updatedAt"
FROM "Conversation"
WHERE "summarizedThrough" > 0;
