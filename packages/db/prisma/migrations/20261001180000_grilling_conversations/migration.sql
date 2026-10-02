-- Grilling Conversations (ticket 0044): each holder of a round's Team Role
-- answers its questions in their own Conversation, with follow-ups.

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "grillingRoundId" TEXT,
ADD COLUMN     "grillingState" JSONB;

-- AlterTable
ALTER TABLE "GrillingQuestion" ADD COLUMN     "followUps" JSONB;

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_grillingRoundId_ownerId_key" ON "Conversation"("grillingRoundId", "ownerId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_grillingRoundId_fkey" FOREIGN KEY ("grillingRoundId") REFERENCES "GrillingRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A Grilling Conversation is about the Project as a whole, and always has its state.
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_grilling_check"
  CHECK ("grillingRoundId" IS NULL OR ("featureId" IS NULL AND "grillingState" IS NOT NULL));
-- Follow-ups belong to an answer.
ALTER TABLE "GrillingQuestion" ADD CONSTRAINT "GrillingQuestion_follow_ups_check"
  CHECK ("followUps" IS NULL OR "answer" IS NOT NULL);
