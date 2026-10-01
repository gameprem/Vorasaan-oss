-- Several AI providers and Approved Models (ticket 0053, ADR 0010).
-- An existing install keeps working unchanged: its LLM integration becomes the
-- first provider, and that provider's model becomes the default Approved Model.

-- CreateEnum
CREATE TYPE "AiTaskKind" AS ENUM ('CHOICES', 'SPEC_PROPOSAL', 'SUMMARIES', 'GRILLING', 'FEATURE_SUGGESTIONS', 'FIT_CHECK', 'CHAT');

-- An Organization may now connect several LLM providers.
DROP INDEX "OrgIntegration_organizationId_provider_key";

-- AlterTable
ALTER TABLE "OrgIntegration" ADD COLUMN "name" TEXT;

-- CreateTable
CREATE TABLE "ApprovedModel" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "modelId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "note" TEXT,
    "position" INTEGER NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApprovedModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiTaskModel" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "task" "AiTaskKind" NOT NULL,
    "approvedModelId" TEXT NOT NULL,

    CONSTRAINT "AiTaskModel_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApprovedModel_organizationId_position_idx" ON "ApprovedModel"("organizationId", "position");

-- CreateIndex
CREATE INDEX "ApprovedModel_integrationId_idx" ON "ApprovedModel"("integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "ApprovedModel_organizationId_displayName_key" ON "ApprovedModel"("organizationId", "displayName");

-- CreateIndex
CREATE INDEX "AiTaskModel_approvedModelId_idx" ON "AiTaskModel"("approvedModelId");

-- CreateIndex
CREATE UNIQUE INDEX "AiTaskModel_organizationId_task_key" ON "AiTaskModel"("organizationId", "task");

-- CreateIndex
CREATE INDEX "OrgIntegration_organizationId_provider_idx" ON "OrgIntegration"("organizationId", "provider");

-- AddForeignKey
ALTER TABLE "ApprovedModel" ADD CONSTRAINT "ApprovedModel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApprovedModel" ADD CONSTRAINT "ApprovedModel_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "OrgIntegration"("id") ON DELETE NO ACTION ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTaskModel" ADD CONSTRAINT "AiTaskModel_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiTaskModel" ADD CONSTRAINT "AiTaskModel_approvedModelId_fkey" FOREIGN KEY ("approvedModelId") REFERENCES "ApprovedModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data: every LLM integration becomes a provider, named after its kind.
UPDATE "OrgIntegration"
SET "name" = CASE "provider"
    WHEN 'ANTHROPIC' THEN 'Anthropic'
    WHEN 'OPENAI' THEN 'OpenAI'
    ELSE 'Custom endpoint'
  END
WHERE "provider" IN ('ANTHROPIC', 'OPENAI', 'OPENAI_COMPATIBLE');

-- Data: the default provider's model becomes the Organization's default Approved
-- Model, named after the model. Providers that weren't the default get no
-- Approved Model: nobody could use them before, so nobody can now.
INSERT INTO "ApprovedModel" ("id", "organizationId", "integrationId", "modelId", "displayName", "position", "isDefault", "createdAt", "updatedAt")
SELECT DISTINCT ON ("organizationId")
  gen_random_uuid()::text, "organizationId", "id", btrim("model"), btrim("model"), 0, true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "OrgIntegration"
WHERE "isDefaultLlm"
  AND "provider" IN ('ANTHROPIC', 'OPENAI', 'OPENAI_COMPATIBLE')
  AND "model" IS NOT NULL AND btrim("model") <> ''
ORDER BY "organizationId", "updatedAt" DESC;

-- LLM models now live in ApprovedModel only.
UPDATE "OrgIntegration" SET "model" = NULL WHERE "provider" IN ('ANTHROPIC', 'OPENAI', 'OPENAI_COMPATIBLE');

-- The default is an Approved Model now.
ALTER TABLE "OrgIntegration" DROP COLUMN "isDefaultLlm";

-- At most one Atlassian site and one embeddings endpoint per Organization.
CREATE UNIQUE INDEX "OrgIntegration_one_per_organization" ON "OrgIntegration"("organizationId", "provider") WHERE "provider" IN ('ATLASSIAN', 'EMBEDDINGS');

-- At most one default Approved Model per Organization (the service keeps exactly one).
CREATE UNIQUE INDEX "ApprovedModel_one_default_per_organization" ON "ApprovedModel"("organizationId") WHERE "isDefault";
