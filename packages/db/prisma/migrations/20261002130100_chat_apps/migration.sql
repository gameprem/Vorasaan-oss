-- CreateEnum
CREATE TYPE "ChatProvider" AS ENUM ('LINE', 'SLACK', 'TEAMS');

-- CreateEnum
CREATE TYPE "ChatEventKind" AS ENUM ('DECISION_REQUEST', 'NEEDS_INFO', 'SPEC_PROPOSAL', 'ESCALATION');

-- AlterTable
ALTER TABLE "OrgIntegration" ADD COLUMN     "appId" TEXT;

-- At most one of each chat app per Organization (the Organization's bot for it).
CREATE UNIQUE INDEX "OrgIntegration_one_chat_app_per_organization" ON "OrgIntegration"("organizationId", "provider") WHERE "provider" IN ('LINE', 'SLACK', 'TEAMS');

-- CreateTable
CREATE TABLE "ChatAccount" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "ChatProvider" NOT NULL,
    "providerUserId" TEXT NOT NULL,
    "address" JSONB NOT NULL,
    "displayName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatLinkCode" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" "ChatProvider" NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatLinkCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatPreference" (
    "userId" TEXT NOT NULL,
    "events" "ChatEventKind"[],
    "quietStartMinute" INTEGER,
    "quietEndMinute" INTEGER,
    "timeZone" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatPreference_pkey" PRIMARY KEY ("userId")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatAccount_organizationId_provider_providerUserId_key" ON "ChatAccount"("organizationId", "provider", "providerUserId");

-- CreateIndex
CREATE UNIQUE INDEX "ChatAccount_userId_provider_key" ON "ChatAccount"("userId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "ChatLinkCode_codeHash_key" ON "ChatLinkCode"("codeHash");

-- CreateIndex
CREATE INDEX "ChatLinkCode_userId_provider_idx" ON "ChatLinkCode"("userId", "provider");

-- AddForeignKey
ALTER TABLE "ChatAccount" ADD CONSTRAINT "ChatAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatAccount" ADD CONSTRAINT "ChatAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatLinkCode" ADD CONSTRAINT "ChatLinkCode_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatLinkCode" ADD CONSTRAINT "ChatLinkCode_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatPreference" ADD CONSTRAINT "ChatPreference_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
