ALTER TABLE "Conversation"
  ADD COLUMN "chatRecoveryEpoch" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "Conversation"
  ADD CONSTRAINT "Conversation_chatRecoveryEpoch_non_negative_check"
  CHECK (
    "chatRecoveryEpoch" >= 0 AND
    "chatRecoveryEpoch" < 2147483647
  );
