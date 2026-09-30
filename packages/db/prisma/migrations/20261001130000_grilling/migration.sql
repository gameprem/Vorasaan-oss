-- CreateEnum
CREATE TYPE "GrillingStatus" AS ENUM ('RUNNING', 'DRAFTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "GrillingRoundKind" AS ENUM ('BUSINESS', 'UX', 'TECHNICAL');

-- CreateEnum
CREATE TYPE "GrillingRoundStatus" AS ENUM ('ASKING', 'ANSWERED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "GrillingSkipReason" AS ENUM ('NO_ONE_WITH_ROLE', 'NOTHING_TO_ASK', 'BY_STARTER');

-- AlterTable
ALTER TABLE "BriefProposal" ADD COLUMN     "summary" TEXT;

-- CreateTable
CREATE TABLE "Grilling" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "startedById" TEXT NOT NULL,
    "status" "GrillingStatus" NOT NULL DEFAULT 'RUNNING',
    "currentRound" "GrillingRoundKind",
    "memory" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "proposalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Grilling_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrillingRound" (
    "id" TEXT NOT NULL,
    "grillingId" TEXT NOT NULL,
    "kind" "GrillingRoundKind" NOT NULL,
    "role" "TeamRole" NOT NULL,
    "status" "GrillingRoundStatus" NOT NULL,
    "skipReason" "GrillingSkipReason",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "GrillingRound_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GrillingQuestion" (
    "id" TEXT NOT NULL,
    "grillingId" TEXT NOT NULL,
    "roundId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "answer" TEXT,
    "answeredById" TEXT,
    "answeredAt" TIMESTAMP(3),
    "skipped" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GrillingQuestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Grilling_proposalId_key" ON "Grilling"("proposalId");

-- CreateIndex
CREATE INDEX "Grilling_projectId_createdAt_idx" ON "Grilling"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "GrillingRound_status_role_idx" ON "GrillingRound"("status", "role");

-- CreateIndex
CREATE UNIQUE INDEX "GrillingRound_grillingId_kind_key" ON "GrillingRound"("grillingId", "kind");

-- CreateIndex
CREATE INDEX "GrillingQuestion_grillingId_idx" ON "GrillingQuestion"("grillingId");

-- CreateIndex
CREATE UNIQUE INDEX "GrillingQuestion_roundId_position_key" ON "GrillingQuestion"("roundId", "position");

-- AddForeignKey
ALTER TABLE "Grilling" ADD CONSTRAINT "Grilling_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grilling" ADD CONSTRAINT "Grilling_startedById_fkey" FOREIGN KEY ("startedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Grilling" ADD CONSTRAINT "Grilling_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "BriefProposal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrillingRound" ADD CONSTRAINT "GrillingRound_grillingId_fkey" FOREIGN KEY ("grillingId") REFERENCES "Grilling"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrillingQuestion" ADD CONSTRAINT "GrillingQuestion_grillingId_fkey" FOREIGN KEY ("grillingId") REFERENCES "Grilling"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrillingQuestion" ADD CONSTRAINT "GrillingQuestion_roundId_fkey" FOREIGN KEY ("roundId") REFERENCES "GrillingRound"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GrillingQuestion" ADD CONSTRAINT "GrillingQuestion_answeredById_fkey" FOREIGN KEY ("answeredById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- At most one RUNNING Grilling per Project, whoever starts it.
CREATE UNIQUE INDEX "Grilling_one_running_per_project" ON "Grilling"("projectId") WHERE "status" = 'RUNNING';

-- At most one round of a Grilling waits for answers at a time.
CREATE UNIQUE INDEX "GrillingRound_one_asking_per_grilling" ON "GrillingRound"("grillingId") WHERE "status" = 'ASKING';

-- Each round goes to one Team Role: business to POs, UX to Designers, technical to Tech Leads.
ALTER TABLE "GrillingRound" ADD CONSTRAINT "GrillingRound_role_check"
  CHECK (("kind" = 'BUSINESS' AND "role" = 'PO') OR ("kind" = 'UX' AND "role" = 'DESIGNER') OR ("kind" = 'TECHNICAL' AND "role" = 'TECH_LEAD'));
