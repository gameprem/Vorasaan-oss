-- CreateEnum
CREATE TYPE "ResponseWindowUnit" AS ENUM ('WORKING_HOURS', 'WORKING_DAYS');

-- CreateEnum
CREATE TYPE "RequestHistoryKind" AS ENUM ('REMINDED', 'DELEGATES_ADDED', 'OVERDUE_REPORTED');

-- AlterEnum
ALTER TYPE "NotificationType" ADD VALUE 'REQUEST_REMINDER';
ALTER TYPE "NotificationType" ADD VALUE 'REQUEST_ESCALATED';
ALTER TYPE "NotificationType" ADD VALUE 'REQUEST_OVERDUE';

-- AlterTable
ALTER TABLE "DecisionRequest" ADD COLUMN     "dueAt" TIMESTAMP(3),
ADD COLUMN     "escalationStep" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "pausedAt" TIMESTAMP(3),
ADD COLUMN     "responseWindowMinutes" INTEGER;

-- AlterTable
ALTER TABLE "Project" ADD COLUMN     "blockerWindow" INTEGER,
ADD COLUMN     "blockerWindowUnit" "ResponseWindowUnit",
ADD COLUMN     "questionWindow" INTEGER,
ADD COLUMN     "questionWindowUnit" "ResponseWindowUnit";

-- CreateTable
CREATE TABLE "ResponseWindowSettings" (
    "organizationId" TEXT NOT NULL,
    "timeZone" TEXT NOT NULL,
    "workingDays" INTEGER[],
    "workStartMinute" INTEGER NOT NULL,
    "workEndMinute" INTEGER NOT NULL,
    "blockerWindow" INTEGER NOT NULL,
    "blockerWindowUnit" "ResponseWindowUnit" NOT NULL,
    "questionWindow" INTEGER NOT NULL,
    "questionWindowUnit" "ResponseWindowUnit" NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResponseWindowSettings_pkey" PRIMARY KEY ("organizationId")
);

-- CreateTable
CREATE TABLE "OrgHoliday" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "OrgHoliday_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RequestHistoryEntry" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "kind" "RequestHistoryKind" NOT NULL,
    "people" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RequestHistoryEntry_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OrgHoliday_organizationId_date_key" ON "OrgHoliday"("organizationId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "RequestHistoryEntry_requestId_kind_key" ON "RequestHistoryEntry"("requestId", "kind");

-- CreateIndex
CREATE INDEX "DecisionRequest_status_dueAt_idx" ON "DecisionRequest"("status", "dueAt");

-- AddForeignKey
ALTER TABLE "ResponseWindowSettings" ADD CONSTRAINT "ResponseWindowSettings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgHoliday" ADD CONSTRAINT "OrgHoliday_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RequestHistoryEntry" ADD CONSTRAINT "RequestHistoryEntry_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "DecisionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;
