-- CreateTable
CREATE TABLE "Platform" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "roles" "TeamRole"[],
    "specSection" BOOLEAN NOT NULL DEFAULT true,
    "someoneToAsk" BOOLEAN NOT NULL DEFAULT true,
    "noOpenBlockers" BOOLEAN NOT NULL DEFAULT true,
    "qaReady" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Platform_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FeaturePlatform" (
    "featureId" TEXT NOT NULL,
    "platformId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FeaturePlatform_pkey" PRIMARY KEY ("featureId","platformId")
);

-- CreateTable
CREATE TABLE "OrgPlatformTemplate" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "roles" "TeamRole"[],
    "specSection" BOOLEAN NOT NULL DEFAULT true,
    "someoneToAsk" BOOLEAN NOT NULL DEFAULT true,
    "noOpenBlockers" BOOLEAN NOT NULL DEFAULT true,
    "qaReady" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgPlatformTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Platform_projectId_position_idx" ON "Platform"("projectId", "position");

-- CreateIndex
CREATE INDEX "FeaturePlatform_platformId_idx" ON "FeaturePlatform"("platformId");

-- CreateIndex
CREATE INDEX "OrgPlatformTemplate_organizationId_position_idx" ON "OrgPlatformTemplate"("organizationId", "position");

-- AddForeignKey
ALTER TABLE "Platform" ADD CONSTRAINT "Platform_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeaturePlatform" ADD CONSTRAINT "FeaturePlatform_featureId_fkey" FOREIGN KEY ("featureId") REFERENCES "Feature"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FeaturePlatform" ADD CONSTRAINT "FeaturePlatform_platformId_fkey" FOREIGN KEY ("platformId") REFERENCES "Platform"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrgPlatformTemplate" ADD CONSTRAINT "OrgPlatformTemplate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- A Platform's name is unique in its Project ignoring case: a Spec section matches its
-- `##` heading case-insensitively, so "Flutter" and "flutter" would be the same section.
CREATE UNIQUE INDEX "Platform_projectId_name_key" ON "Platform"("projectId", lower("name"));

-- Existing Projects start from the built-in template (ticket 0050), every check on.
-- Their Features target nothing yet: nothing recorded which Platforms they ship on.
INSERT INTO "Platform" ("id", "projectId", "name", "position", "roles")
SELECT gen_random_uuid()::text, p."id", t."name", t."position", t."roles"
FROM "Project" p
CROSS JOIN (VALUES
  ('Back-End', 0, ARRAY['BACKEND']::"TeamRole"[]),
  ('Front-End', 1, ARRAY['FRONTEND']::"TeamRole"[]),
  ('Mobile', 2, ARRAY['MOBILE']::"TeamRole"[])
) AS t("name", "position", "roles");
