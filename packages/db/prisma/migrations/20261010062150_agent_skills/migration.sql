-- Ticket 0078 (ADR 0017): Agent Skills an Admin installs from GitHub or a zip, pinned, approved
-- and enabled per Project; their files live in FileStorage. Receipts record the Skills a call read.
-- CreateEnum
CREATE TYPE "AgentSkillSource" AS ENUM ('GITHUB', 'ZIP');

-- CreateEnum
CREATE TYPE "AgentSkillVersionStatus" AS ENUM ('PENDING', 'APPROVED', 'DECLINED', 'REPLACED');

-- CreateTable
CREATE TABLE "AgentSkill" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "source" "AgentSkillSource" NOT NULL,
    "repository" TEXT,
    "ref" TEXT,
    "subpath" TEXT NOT NULL DEFAULT '',
    "activeVersionId" TEXT,
    "installedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSkill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSkillVersion" (
    "id" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "AgentSkillVersionStatus" NOT NULL DEFAULT 'PENDING',
    "pinned" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "license" TEXT,
    "skippedFiles" JSONB NOT NULL,
    "totalBytes" INTEGER NOT NULL,
    "fetchedById" TEXT,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSkillVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSkillFile" (
    "id" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,

    CONSTRAINT "AgentSkillFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectAgentSkill" (
    "projectId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "enabledById" TEXT,
    "enabledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectAgentSkill_pkey" PRIMARY KEY ("projectId","skillId")
);

-- CreateTable
CREATE TABLE "ReceiptAgentSkill" (
    "receiptId" TEXT NOT NULL,
    "skillId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "pinned" TEXT NOT NULL,

    CONSTRAINT "ReceiptAgentSkill_pkey" PRIMARY KEY ("receiptId","skillId")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkill_activeVersionId_key" ON "AgentSkill"("activeVersionId");

-- CreateIndex
CREATE INDEX "AgentSkill_installedById_idx" ON "AgentSkill"("installedById");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkill_organizationId_name_key" ON "AgentSkill"("organizationId", "name");

-- CreateIndex
CREATE INDEX "AgentSkillVersion_fetchedById_idx" ON "AgentSkillVersion"("fetchedById");

-- CreateIndex
CREATE INDEX "AgentSkillVersion_decidedById_idx" ON "AgentSkillVersion"("decidedById");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkillVersion_skillId_number_key" ON "AgentSkillVersion"("skillId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSkillFile_versionId_path_key" ON "AgentSkillFile"("versionId", "path");

-- CreateIndex
CREATE INDEX "ProjectAgentSkill_skillId_idx" ON "ProjectAgentSkill"("skillId");

-- CreateIndex
CREATE INDEX "ProjectAgentSkill_enabledById_idx" ON "ProjectAgentSkill"("enabledById");

-- CreateIndex
CREATE INDEX "ReceiptAgentSkill_skillId_idx" ON "ReceiptAgentSkill"("skillId");

-- AddForeignKey
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_installedById_fkey" FOREIGN KEY ("installedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkill" ADD CONSTRAINT "AgentSkill_activeVersionId_fkey" FOREIGN KEY ("activeVersionId") REFERENCES "AgentSkillVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkillVersion" ADD CONSTRAINT "AgentSkillVersion_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "AgentSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkillVersion" ADD CONSTRAINT "AgentSkillVersion_fetchedById_fkey" FOREIGN KEY ("fetchedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkillVersion" ADD CONSTRAINT "AgentSkillVersion_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSkillFile" ADD CONSTRAINT "AgentSkillFile_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "AgentSkillVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAgentSkill" ADD CONSTRAINT "ProjectAgentSkill_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAgentSkill" ADD CONSTRAINT "ProjectAgentSkill_skillId_fkey" FOREIGN KEY ("skillId") REFERENCES "AgentSkill"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectAgentSkill" ADD CONSTRAINT "ProjectAgentSkill_enabledById_fkey" FOREIGN KEY ("enabledById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReceiptAgentSkill" ADD CONSTRAINT "ReceiptAgentSkill_receiptId_fkey" FOREIGN KEY ("receiptId") REFERENCES "Receipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- At most one version of a Skill waits for a decision at a time (an install or an update).
CREATE UNIQUE INDEX "AgentSkillVersion_one_pending" ON "AgentSkillVersion"("skillId") WHERE "status" = 'PENDING';
