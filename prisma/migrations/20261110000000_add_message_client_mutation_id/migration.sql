-- AlterTable
ALTER TABLE "Message" ADD COLUMN "clientMutationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Message_conversationId_senderId_clientMutationId_key" ON "Message"("conversationId", "senderId", "clientMutationId");

