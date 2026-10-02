-- AlterTable
ALTER TABLE "RequestRecipient" ADD COLUMN     "onBehalfOfId" TEXT;

-- CreateIndex
CREATE INDEX "RequestRecipient_onBehalfOfId_idx" ON "RequestRecipient"("onBehalfOfId");

-- AddForeignKey
ALTER TABLE "RequestRecipient" ADD CONSTRAINT "RequestRecipient_onBehalfOfId_fkey" FOREIGN KEY ("onBehalfOfId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
