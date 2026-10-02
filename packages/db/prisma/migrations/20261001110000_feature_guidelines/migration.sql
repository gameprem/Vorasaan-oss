-- CreateEnum
CREATE TYPE "GuidelineCriterionKind" AS ENUM ('KPI', 'CONSTRAINT', 'REQUIRED_SECTION');

-- CreateTable
CREATE TABLE "GuidelineCriterion" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT,
    "overridesId" TEXT,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "kind" "GuidelineCriterionKind" NOT NULL,
    "required" BOOLEAN NOT NULL,
    "disabled" BOOLEAN NOT NULL DEFAULT false,
    "position" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GuidelineCriterion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "GuidelineCriterion_organizationId_projectId_position_idx" ON "GuidelineCriterion"("organizationId", "projectId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "GuidelineCriterion_projectId_overridesId_key" ON "GuidelineCriterion"("projectId", "overridesId");

-- AddForeignKey
ALTER TABLE "GuidelineCriterion" ADD CONSTRAINT "GuidelineCriterion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuidelineCriterion" ADD CONSTRAINT "GuidelineCriterion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuidelineCriterion" ADD CONSTRAINT "GuidelineCriterion_overridesId_fkey" FOREIGN KEY ("overridesId") REFERENCES "GuidelineCriterion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Only a Project override may reference a default criterion, and only such a reference may be disabled.
ALTER TABLE "GuidelineCriterion" ADD CONSTRAINT "GuidelineCriterion_override_shape_check"
  CHECK (("overridesId" IS NULL OR "projectId" IS NOT NULL) AND (NOT "disabled" OR "overridesId" IS NOT NULL));
