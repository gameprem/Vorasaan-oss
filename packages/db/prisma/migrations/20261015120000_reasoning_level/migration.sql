-- Ticket 0081: the Reasoning Level, per AI task (an Admin's setting), per chat message
-- ("Think deeper") and on each Receipt.

-- CreateEnum
CREATE TYPE "ReasoningLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "AiTaskReasoning" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "task" "AiTaskKind" NOT NULL,
    "level" "ReasoningLevel" NOT NULL,

    CONSTRAINT "AiTaskReasoning_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AiTaskReasoning_organizationId_task_key" ON "AiTaskReasoning"("organizationId", "task");

-- AddForeignKey
ALTER TABLE "AiTaskReasoning" ADD CONSTRAINT "AiTaskReasoning_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "ConversationMessage" ADD COLUMN "reasoningLevel" "ReasoningLevel",
ADD COLUMN "reasoningTokens" INTEGER;

-- AlterTable
ALTER TABLE "Receipt" ADD COLUMN "reasoningLevel" TEXT;
