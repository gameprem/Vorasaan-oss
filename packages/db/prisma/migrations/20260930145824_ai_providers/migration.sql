-- AlterEnum
ALTER TYPE "IntegrationProvider" ADD VALUE 'OPENAI';

-- AlterTable
ALTER TABLE "OrgIntegration" ADD COLUMN     "model" TEXT;
