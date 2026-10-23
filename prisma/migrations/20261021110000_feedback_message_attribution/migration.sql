ALTER TABLE "Feedback" ADD COLUMN "messageId" TEXT;
CREATE INDEX "Feedback_messageId_idx" ON "Feedback"("messageId");
ALTER TABLE "Feedback" ADD CONSTRAINT "Feedback_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;
