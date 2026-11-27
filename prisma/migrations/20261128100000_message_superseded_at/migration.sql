-- Owner approval 2026-11-27: "Regenerate" and "edit your last message" mark the
-- replaced question and answer on the server, so every device dims them and
-- leaves them out of later model context. NULL means the message stands.
-- Nullable, no default, no backfill, no index: existing rows keep NULL and
-- readers filter within one conversation (Message_conversationId_idx).
ALTER TABLE "Message" ADD COLUMN "supersededAt" TIMESTAMP(3);
