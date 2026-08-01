-- AlterTable
ALTER TABLE "Conversation" ADD COLUMN     "importedGuestKey" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_userId_importedGuestKey_key" ON "Conversation"("userId", "importedGuestKey");
