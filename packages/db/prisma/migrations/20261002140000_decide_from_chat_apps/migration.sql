-- CreateEnum
CREATE TYPE "DecisionSource" AS ENUM ('WEB', 'CLI', 'LINE', 'SLACK', 'TEAMS');

-- CreateEnum
CREATE TYPE "ChatCardStatus" AS ENUM ('PENDING', 'SENT', 'SKIPPED', 'FAILED');

-- AlterTable
ALTER TABLE "ChatPreference" ADD COLUMN     "language" TEXT;

-- AlterTable
ALTER TABLE "Decision" ADD COLUMN     "source" "DecisionSource" NOT NULL DEFAULT 'WEB';

-- CreateTable
CREATE TABLE "ChatCard" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "ChatProvider" NOT NULL,
    "event" "ChatEventKind" NOT NULL,
    "requestId" TEXT,
    "specProposalId" TEXT,
    "escalationStep" INTEGER,
    "status" "ChatCardStatus" NOT NULL DEFAULT 'PENDING',
    "messageRef" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "ChatCard_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChatCard_status_createdAt_idx" ON "ChatCard"("status", "createdAt");

-- CreateIndex
CREATE INDEX "ChatCard_requestId_idx" ON "ChatCard"("requestId");

-- AddForeignKey
ALTER TABLE "ChatCard" ADD CONSTRAINT "ChatCard_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatCard" ADD CONSTRAINT "ChatCard_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "DecisionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
