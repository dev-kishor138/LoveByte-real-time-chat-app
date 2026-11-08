-- AlterTable
ALTER TABLE "User" ADD COLUMN "displayName" TEXT,
ADD COLUMN "lastSeenAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Message" ADD COLUMN "readAt" TIMESTAMP(3);

-- CreateIndex
CREATE INDEX "Message_conversationId_readAt_idx" ON "Message"("conversationId", "readAt");

