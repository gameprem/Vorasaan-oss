-- CreateEnum
CREATE TYPE "FeatureSuggestionStatus" AS ENUM ('PENDING', 'ACCEPTED', 'DISMISSED');

-- CreateEnum
CREATE TYPE "SuggestionLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH');

-- CreateTable
CREATE TABLE "FeatureSuggestion" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "businessValue" TEXT NOT NULL,
    "effort" "SuggestionLevel" NOT NULL,
    "risk" "SuggestionLevel" NOT NULL,
    "servesGuidelineIds" TEXT[],
    "status" "FeatureSuggestionStatus" NOT NULL DEFAULT 'PENDING',
    "dismissReason" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "featureId" TEXT,
    "generatedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeatureSuggestion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "FeatureSuggestion_featureId_key" ON "FeatureSuggestion"("featureId");

-- CreateIndex
CREATE INDEX "FeatureSuggestion_projectId_status_createdAt_idx" ON "FeatureSuggestion"("projectId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "FeatureSuggestion" ADD CONSTRAINT "FeatureSuggestion_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureSuggestion" ADD CONSTRAINT "FeatureSuggestion_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureSuggestion" ADD CONSTRAINT "FeatureSuggestion_generatedById_fkey" FOREIGN KEY ("generatedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeatureSuggestion" ADD CONSTRAINT "FeatureSuggestion_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A dismissed Feature Suggestion always says why; the reason goes back to the AI.
ALTER TABLE "FeatureSuggestion" ADD CONSTRAINT "FeatureSuggestion_dismiss_reason_check"
  CHECK ("status" <> 'DISMISSED' OR "dismissReason" IS NOT NULL);
