-- CreateEnum
CREATE TYPE "DeciderChangeKind" AS ENUM ('CLAIMED', 'REASSIGNED');

-- CreateTable
CREATE TABLE "DeciderChange" (
    "id" TEXT NOT NULL,
    "requestId" TEXT NOT NULL,
    "deciderId" TEXT NOT NULL,
    "kind" "DeciderChangeKind" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeciderChange_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "DeciderChange_requestId_createdAt_idx" ON "DeciderChange"("requestId", "createdAt");

-- AddForeignKey
ALTER TABLE "DeciderChange" ADD CONSTRAINT "DeciderChange_requestId_fkey" FOREIGN KEY ("requestId") REFERENCES "DecisionRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeciderChange" ADD CONSTRAINT "DeciderChange_deciderId_fkey" FOREIGN KEY ("deciderId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

