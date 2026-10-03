-- AlterTable
ALTER TABLE "OrgMembership" ADD COLUMN     "gettingStartedDismissedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "language" TEXT NOT NULL DEFAULT 'en';
