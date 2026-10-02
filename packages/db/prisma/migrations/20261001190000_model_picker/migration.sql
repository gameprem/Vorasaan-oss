-- The model picker in chat (ticket 0054): the Approved Model picked in a Conversation,
-- and the model that wrote each AI reply and drafted each proposal, kept as a snapshot.

-- AlterTable
ALTER TABLE "BriefProposal" ADD COLUMN     "approvedModelId" TEXT,
ADD COLUMN     "modelDisplayName" TEXT,
ADD COLUMN     "modelName" TEXT;

-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "modelId" TEXT;

-- AlterTable
ALTER TABLE "ConversationMessage" ADD COLUMN     "approvedModelId" TEXT,
ADD COLUMN     "modelDisplayName" TEXT,
ADD COLUMN     "modelName" TEXT,
ADD COLUMN     "modelNotice" TEXT;

-- AlterTable
ALTER TABLE "DecisionRequest" ADD COLUMN     "choicesApprovedModelId" TEXT,
ADD COLUMN     "choicesModelDisplayName" TEXT,
ADD COLUMN     "choicesModelName" TEXT;

-- AlterTable
ALTER TABLE "SpecProposal" ADD COLUMN     "approvedModelId" TEXT,
ADD COLUMN     "modelDisplayName" TEXT,
ADD COLUMN     "modelName" TEXT;

-- CreateIndex
CREATE INDEX "Conversation_modelId_idx" ON "Conversation"("modelId");

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_modelId_fkey" FOREIGN KEY ("modelId") REFERENCES "ApprovedModel"("id") ON DELETE SET NULL ON UPDATE CASCADE;
