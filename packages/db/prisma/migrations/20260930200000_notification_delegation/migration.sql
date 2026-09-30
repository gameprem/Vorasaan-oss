-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "delegationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Notification_delegationId_key" ON "Notification"("delegationId");

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_delegationId_fkey" FOREIGN KEY ("delegationId") REFERENCES "Delegation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

